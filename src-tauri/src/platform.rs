//! Conservative text insertion. Automatic insertion never changes the clipboard,
//! activates another app, or synthesizes Enter/Tab. Explicit Copy is separate.

pub use native::InputTarget;

pub fn capture_target() -> Result<InputTarget, String> {
    native::capture_target()
}
pub fn is_target_current(target: &InputTarget) -> bool {
    native::is_target_current(target)
}
pub fn accessibility_granted() -> bool {
    native::accessibility_granted()
}
pub fn request_accessibility() -> bool {
    native::request_accessibility()
}

pub fn copy_text(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .map_err(|error| format!("无法访问剪贴板：{error}"))?
        .set_text(text)
        .map_err(|error| format!("复制失败：{error}"))
}

/// This function submits Unicode keyboard events; an app can still choose to
/// ignore them. Its success does not constitute an acknowledgement from the editor.
pub fn paste_to_target(text: &str, target: &InputTarget) -> Result<(), String> {
    validate_insertion(text)?;
    if text.is_empty() {
        return Ok(());
    }
    if !is_target_current(target) {
        return Err("输入位置已经变化，已保留结果，请手动复制。".into());
    }
    native::insert(text, target, true)
}

/// Confirmed speech can be appended while the recording hotkey is held.
/// Synthetic Unicode events still clear modifier flags and validate the target.
pub fn append_live(text: &str, target: &InputTarget) -> Result<(), String> {
    validate_insertion(text)?;
    if text.is_empty() {
        return Ok(());
    }
    if !is_target_current(target) {
        return Err("输入位置已经变化，已保留结果，请手动复制。".into());
    }
    native::insert(text, target, false)
}

fn validate_insertion(text: &str) -> Result<(), String> {
    if text.chars().any(char::is_control) {
        return Err(
            "结果包含换行、制表符或控制字符，请预览后手动复制，以免触发发送或执行。".into(),
        );
    }
    if text.encode_utf16().count() > 8_000 {
        return Err("结果较长，请预览后手动复制。".into());
    }
    Ok(())
}

/// Keep each scalar's one/two UTF-16 code units in the same OS event batch.
fn unicode_chunks(text: &str) -> Vec<Vec<u16>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::with_capacity(16);
    for character in text.chars() {
        let mut units = [0u16; 2];
        let encoded = character.encode_utf16(&mut units);
        if chunk.len() + encoded.len() > 16 {
            chunks.push(std::mem::replace(&mut chunk, Vec::with_capacity(16)));
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

#[cfg(target_os = "macos")]
mod native {
    use super::unicode_chunks;
    use std::{
        ffi::{c_char, c_void, CStr},
        ptr,
        sync::Arc,
        thread,
        time::Duration,
    };

    type CFRef = *const c_void;
    type Object = *mut c_void;

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Object;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> Object;
        fn objc_autoreleasePoolPop(pool: Object);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFRef;
        fn AXUIElementCreateApplication(pid: i32) -> CFRef;
        fn AXUIElementCopyAttributeValue(
            element: CFRef,
            attribute: CFRef,
            value: *mut CFRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFRef, seconds: f32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: CFRef);
        fn CFEqual(first: CFRef, second: CFRef) -> u8;
        fn CFStringCreateWithCString(allocator: CFRef, text: *const c_char, encoding: u32)
            -> CFRef;
        fn CFDictionaryCreate(
            allocator: CFRef,
            keys: *const CFRef,
            values: *const CFRef,
            count: isize,
            key_callbacks: CFRef,
            value_callbacks: CFRef,
        ) -> CFRef;
        static kCFBooleanTrue: CFRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateKeyboardEvent(source: CFRef, key: u16, down: bool) -> CFRef;
        fn CGEventKeyboardSetUnicodeString(event: CFRef, length: usize, text: *const u16);
        fn CGEventSetFlags(event: CFRef, flags: u64);
        fn CGEventPostToPid(pid: i32, event: CFRef);
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }

    /// Retained immutable AX references. CF retain/release and AX queries are
    /// thread-safe; all instances are only accessed through shared references.
    #[derive(Debug)]
    struct OwnedCf(CFRef);
    unsafe impl Send for OwnedCf {}
    unsafe impl Sync for OwnedCf {}
    impl Drop for OwnedCf {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    impl OwnedCf {
        fn new(value: CFRef) -> Result<Self, String> {
            if value.is_null() {
                Err("无法获取系统对象".into())
            } else {
                Ok(Self(value))
            }
        }
    }

    #[derive(Clone, Debug)]
    pub struct InputTarget {
        pid: i32,
        application: Arc<OwnedCf>,
        focused_element: Arc<OwnedCf>,
        focused_window: Option<Arc<OwnedCf>>,
    }

    unsafe fn send_object(receiver: Object, selector: &'static CStr) -> Object {
        let send: unsafe extern "C" fn(Object, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, sel_registerName(selector.as_ptr()))
    }

    fn foreground_pid() -> Result<i32, String> {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let workspace = send_object(objc_getClass(c"NSWorkspace".as_ptr()), c"sharedWorkspace");
            let frontmost = send_object(workspace, c"frontmostApplication");
            let send_pid: unsafe extern "C" fn(Object, Object) -> i32 =
                std::mem::transmute(objc_msgSend as *const ());
            let pid = if frontmost.is_null() {
                0
            } else {
                send_pid(frontmost, sel_registerName(c"processIdentifier".as_ptr()))
            };
            objc_autoreleasePoolPop(pool);
            if pid > 0 {
                Ok(pid)
            } else {
                Err("无法确定当前输入应用".into())
            }
        }
    }

    fn attribute(element: &OwnedCf, name: &'static CStr) -> Result<OwnedCf, String> {
        unsafe {
            let attribute = OwnedCf::new(CFStringCreateWithCString(
                ptr::null(),
                name.as_ptr(),
                0x08000100,
            ))?;
            let mut value = ptr::null();
            let status = AXUIElementCopyAttributeValue(element.0, attribute.0, &mut value);
            if status != 0 {
                return Err(format!(
                    "当前应用未提供输入焦点信息（{status}），请手动复制结果。"
                ));
            }
            OwnedCf::new(value)
        }
    }

    pub fn accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn request_accessibility() -> bool {
        unsafe {
            let key = kAXTrustedCheckOptionPrompt;
            let value = kCFBooleanTrue;
            let Ok(options) = OwnedCf::new(CFDictionaryCreate(
                ptr::null(),
                &key,
                &value,
                1,
                ptr::null(),
                ptr::null(),
            )) else {
                return false;
            };
            AXIsProcessTrustedWithOptions(options.0)
        }
    }

    pub fn capture_target() -> Result<InputTarget, String> {
        let pid = foreground_pid()?;
        if pid as u32 == std::process::id() {
            return Err("当前焦点在 FlowVoice，将保留结果供预览和复制。".into());
        }
        if !accessibility_granted() {
            return Err("自动输入需要 macOS 辅助功能权限；本次结果将保留供复制。".into());
        }
        let application = Arc::new(OwnedCf::new(unsafe { AXUIElementCreateApplication(pid) })?);
        unsafe {
            AXUIElementSetMessagingTimeout(application.0, 0.2);
        }
        let focused_element = Arc::new(attribute(&application, c"AXFocusedUIElement")?);
        let focused_window = attribute(&application, c"AXFocusedWindow")
            .ok()
            .map(Arc::new);
        Ok(InputTarget {
            pid,
            application,
            focused_element,
            focused_window,
        })
    }

    pub fn is_target_current(target: &InputTarget) -> bool {
        if foreground_pid().ok() != Some(target.pid) {
            return false;
        }
        let Ok(focused) = attribute(&target.application, c"AXFocusedUIElement") else {
            return false;
        };
        if unsafe { CFEqual(focused.0, target.focused_element.0) } == 0 {
            return false;
        }
        if let Some(window) = &target.focused_window {
            let Ok(current) = attribute(&target.application, c"AXFocusedWindow") else {
                return false;
            };
            if unsafe { CFEqual(current.0, window.0) } == 0 {
                return false;
            }
        }
        true
    }

    fn modifiers_pressed() -> bool {
        unsafe { CGEventSourceFlagsState(0) & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)) != 0 }
    }

    pub fn insert(
        text: &str,
        target: &InputTarget,
        wait_for_modifiers: bool,
    ) -> Result<(), String> {
        if !accessibility_granted() {
            return Err("需要在系统设置中授予 FlowVoice 辅助功能权限。".into());
        }
        if wait_for_modifiers {
            for _ in 0..20 {
                if !modifiers_pressed() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
        for chunk in unicode_chunks(text) {
            if !is_target_current(target) || wait_for_modifiers && modifiers_pressed() {
                return Err("输入焦点或按键状态发生变化，已停止自动输入；可能已输入部分内容，请检查原输入框。".into());
            }
            unsafe {
                let down = OwnedCf::new(CGEventCreateKeyboardEvent(ptr::null(), 0, true))?;
                let up = OwnedCf::new(CGEventCreateKeyboardEvent(ptr::null(), 0, false))?;
                for event in [&down, &up] {
                    CGEventSetFlags(event.0, 0);
                    CGEventKeyboardSetUnicodeString(event.0, chunk.len(), chunk.as_ptr());
                }
                // Targeting the saved PID closes the cross-app race between
                // the focus check and event delivery. Never activate that PID.
                CGEventPostToPid(target.pid, down.0);
                CGEventPostToPid(target.pid, up.0);
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::unicode_chunks;
    use std::{mem::size_of, thread, time::Duration};
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        },
        WindowsAndMessaging::{
            GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
        },
    };

    #[derive(Clone, Debug)]
    pub struct InputTarget {
        pid: u32,
        window: usize,
        focus: usize,
    }

    pub fn accessibility_granted() -> bool {
        true
    }
    pub fn request_accessibility() -> bool {
        true
    }

    pub fn capture_target() -> Result<InputTarget, String> {
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return Err("没有前台应用，结果将保留供复制。".into());
            }
            let mut pid = 0;
            let thread = GetWindowThreadProcessId(window, &mut pid);
            if pid == 0 || pid == std::process::id() {
                return Err("当前焦点在 FlowVoice，将保留结果供预览和复制。".into());
            }
            let mut info: GUITHREADINFO = std::mem::zeroed();
            info.cbSize = size_of::<GUITHREADINFO>() as u32;
            if GetGUIThreadInfo(thread, &mut info) == 0 || info.hwndFocus.is_null() {
                return Err("无法确定当前输入控件，结果将保留供复制。".into());
            }
            Ok(InputTarget {
                pid,
                window: window as usize,
                focus: info.hwndFocus as usize,
            })
        }
    }

    pub fn is_target_current(target: &InputTarget) -> bool {
        // Query both the top-level window and focused child: a switch between
        // windows or input fields of the same application also cancels insertion.
        capture_target().is_ok_and(|current| {
            current.pid == target.pid
                && current.window == target.window
                && current.focus == target.focus
        })
    }

    fn modifiers_pressed() -> bool {
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            .iter()
            .any(|&key| unsafe { GetAsyncKeyState(key as i32) < 0 })
    }

    pub fn insert(
        text: &str,
        target: &InputTarget,
        wait_for_modifiers: bool,
    ) -> Result<(), String> {
        if wait_for_modifiers {
            for _ in 0..20 {
                if !modifiers_pressed() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
        for chunk in unicode_chunks(text) {
            let events: Vec<INPUT> = chunk
                .into_iter()
                .flat_map(|unit| {
                    [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP].map(|flags| INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: 0,
                                wScan: unit,
                                dwFlags: flags,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    })
                })
                .collect();
            if !is_target_current(target) || wait_for_modifiers && modifiers_pressed() {
                return Err("输入焦点或按键状态发生变化，已停止自动输入；可能已输入部分内容，请检查原输入框。".into());
            }
            // Windows has no SendInput-to-HWND API. Revalidate immediately before
            // each small batch; a foreground change during the call remains an OS race.
            let sent = unsafe {
                SendInput(
                    events.len() as u32,
                    events.as_ptr(),
                    size_of::<INPUT>() as i32,
                )
            };
            if sent != events.len() as u32 {
                return Err("Windows 未接受全部输入（目标可能以管理员权限运行），请检查原输入框后手动复制。".into());
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native {
    #[derive(Clone, Debug)]
    pub struct InputTarget;
    pub fn accessibility_granted() -> bool {
        false
    }
    pub fn request_accessibility() -> bool {
        false
    }
    pub fn capture_target() -> Result<InputTarget, String> {
        Err("当前原型仅支持 macOS 和 Windows 自动输入。".into())
    }
    pub fn is_target_current(_: &InputTarget) -> bool {
        false
    }
    pub fn insert(_: &str, _: &InputTarget, _: bool) -> Result<(), String> {
        Err("当前平台不支持自动输入。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_preserve_chinese_and_surrogate_pairs() {
        let text = "测试中文输入😀abcdefghijkl😀结尾🦀";
        let chunks = unicode_chunks(text);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= 16 && String::from_utf16(chunk).is_ok()));
        let flat: Vec<u16> = chunks.into_iter().flatten().collect();
        assert_eq!(String::from_utf16(&flat).unwrap(), text);
    }

    #[test]
    fn automatic_insertion_never_synthesizes_control_characters() {
        assert!(validate_insertion("你好，FlowVoice！😀").is_ok());
        for text in ["hello\nworld", "hello\rworld", "hello\tworld", "\u{1b}"] {
            assert!(validate_insertion(text).is_err());
        }
    }
}
