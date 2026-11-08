//! Join speech fragments and append each fragment to an external editor once.

/// Speech boundaries need a visible space only when the two sides are Latin
/// text or numbers. Chinese prose must not acquire a space at every pause.
pub fn append_fragment(committed: &str, fragment: &str) -> String {
    let fragment = fragment.trim();
    if fragment.is_empty() {
        return committed.to_owned();
    }
    if committed.is_empty() {
        return fragment.to_owned();
    }
    let needs_space = committed
        .chars()
        .last()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && fragment
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric());
    format!(
        "{committed}{}{fragment}",
        if needs_space { " " } else { "" }
    )
}

#[derive(Default)]
pub struct Insertion {
    sent: String,
}

impl Insertion {
    /// Only confirmed fragments cross the app boundary. Replacing a partial
    /// hypothesis with simulated backspaces would disturb the user's editor.
    pub fn next_chunk(&self, committed: &str) -> Result<String, String> {
        committed
            .strip_prefix(&self.sent)
            .map(str::to_owned)
            .ok_or_else(|| "识别文本已修正，已停止自动追加，请使用工作台中的完整结果。".into())
    }

    pub fn mark_sent(&mut self, committed: &str) {
        self.sent = committed.to_owned();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_chinese_without_spaces_and_latin_with_spaces() {
        let mut text = append_fragment("", "今天开会");
        text = append_fragment(&text, "讨论产品");
        assert_eq!(text, "今天开会讨论产品");
        assert_eq!(append_fragment("hello", "world"), "hello world");
    }

    #[test]
    fn emits_only_new_confirmed_suffix() {
        let mut insertion = Insertion::default();
        let first = append_fragment("", "第一句");
        assert_eq!(insertion.next_chunk(&first).unwrap(), "第一句");
        insertion.mark_sent(&first);
        let second = append_fragment(&first, "第二句");
        assert_eq!(insertion.next_chunk(&second).unwrap(), "第二句");
        insertion.mark_sent(&second);
        assert_eq!(insertion.next_chunk(&second).unwrap(), "");
    }
}
