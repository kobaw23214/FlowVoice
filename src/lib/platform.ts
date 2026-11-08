export type DesktopPlatform = 'macos' | 'windows' | 'other';

export function defaultShortcut(platform: DesktopPlatform): string {
  return platform === 'windows' ? 'Control+Shift+Space' : 'Alt+Shift+Space';
}

/** Preserve the physical modifier on each OS when recording global shortcuts. */
export function normalizeShortcut(shortcut: string, platform: DesktopPlatform): string {
  return shortcut.split('+').map((key) => {
    if (['CommandOrControl', 'CmdOrCtrl'].includes(key)) return platform === 'macos' ? 'Super' : 'Control';
    return key;
  }).join('+');
}

/** Browser preview follows the host OS; native builds use the Rust snapshot. */
export function browserPlatform(): DesktopPlatform {
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? 'macos' : 'windows';
}

export function shortcutLabel(shortcut: string, platform: DesktopPlatform, spaceLabel = '空格'): string {
  const mac = platform === 'macos';
  const normalized = normalizeShortcut(shortcut, platform);
  const labels: Record<string, string> = {
    CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Super: mac ? '⌘' : 'Win',
    Control: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Option: mac ? '⌥' : 'Alt',
    Shift: mac ? '⇧' : 'Shift', Space: spaceLabel,
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
    Tab: 'Tab', Enter: mac ? '↩' : 'Enter', Backspace: mac ? '⌫' : 'Backspace',
    Delete: 'Del', Insert: 'Ins', Home: 'Home', End: 'End',
    PageUp: 'PgUp', PageDown: 'PgDn', CapsLock: 'CapsLock', Escape: 'Esc',
  };
  return normalized.split('+').map((code) => labels[code]
    || code.replace(/^Key([A-Z])$/, '$1').replace(/^Digit(\d)$/, '$1')).join(' + ');
}

export function shortcutRecording(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>,
): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'OS'].includes(event.key)) return null;
  const mods: string[] = [];
  if (event.metaKey) mods.push('Super');
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (!mods.length) return null;
  // Some virtual keyboards and remote sessions omit `code` on keydown.
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}`
    : /^\d$/.test(event.key) ? `Digit${event.key}` : event.key);
  return [...mods, code].join('+');
}
