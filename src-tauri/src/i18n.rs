pub struct TrayLabels {
    pub open: &'static str,
    pub cancel: &'static str,
    pub quit: &'static str,
    pub tooltip: &'static str,
}

pub fn tray_labels(language: &str) -> TrayLabels {
    match language {
        "zh-TW" => TrayLabels {
            open: "開啟 FlowVoice",
            cancel: "取消目前任務",
            quit: "結束",
            tooltip: "FlowVoice · 語音輸入",
        },
        "en" => TrayLabels {
            open: "Open FlowVoice",
            cancel: "Cancel current task",
            quit: "Quit",
            tooltip: "FlowVoice · Voice input",
        },
        _ => TrayLabels {
            open: "打开 FlowVoice",
            cancel: "取消当前任务",
            quit: "退出",
            tooltip: "FlowVoice · 语音输入",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::tray_labels;

    #[test]
    fn every_supported_language_has_native_tray_labels() {
        assert_eq!(tray_labels("zh-CN").open, "打开 FlowVoice");
        assert_eq!(tray_labels("zh-TW").open, "開啟 FlowVoice");
        assert_eq!(tray_labels("en").open, "Open FlowVoice");
        assert_eq!(tray_labels("unsupported").open, "打开 FlowVoice");
    }
}
