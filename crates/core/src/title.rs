//! Titles come from the first line of the body that has text, with markdown
//! syntax stripped (docs/design.md#drafts). The stripping is in plain.rs,
//! shared with search snippets.

use crate::plain::{is_fence, is_rule, is_table_divider, line_text};

const MAX_CHARS: usize = 80;
const MAX_LINES_SCANNED: usize = 200;

/// Returns the draft's title, or an empty string when the body has no text.
pub fn title(body: &str) -> String {
    for line in body.lines().take(MAX_LINES_SCANNED) {
        let line = line.trim();
        if line.is_empty() || is_fence(line) || is_rule(line) || is_table_divider(line) {
            continue;
        }
        let text = line_text(line, " | ");
        if !text.is_empty() {
            return truncate(&text);
        }
    }
    String::new()
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_CHARS {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_CHARS).collect();
    // Prefer ending on a word boundary if there's one reasonably close.
    let cut = match cut.rfind(' ') {
        Some(i) if cut[..i].chars().count() >= MAX_CHARS * 3 / 4 => &cut[..i],
        _ => &cut[..],
    };
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::title;

    #[test]
    fn strips_headings_and_inline_syntax() {
        assert_eq!(title("# Title"), "Title");
        assert_eq!(title("## Closing hashes ##"), "Closing hashes");
        assert_eq!(title("**Idea:** thing"), "Idea: thing");
        assert_eq!(title("A [link](https://example.com) and `code`"), "A link and code");
        assert_eq!(title("~~old~~ _new_ \\*literal\\*"), "old new *literal*");
        assert_eq!(title("![alt text](img.png) caption"), "alt text caption");
    }

    #[test]
    fn strips_block_markers() {
        assert_eq!(title("> quoted thought"), "quoted thought");
        assert_eq!(title("- [ ] buy milk"), "buy milk");
        assert_eq!(title("12. twelfth"), "twelfth");
        assert_eq!(title("> - # nested"), "nested");
        assert_eq!(title("| a | b |\n| --- | --- |"), "a | b");
    }

    #[test]
    fn skips_lines_without_text() {
        assert_eq!(title("\n\n---\n\nAfter the rule"), "After the rule");
        assert_eq!(title("```js\nconst x = 1\n```"), "const x = 1");
        assert_eq!(title("| --- | :-: |\nrow"), "row");
        assert_eq!(title("#\n\nreal"), "real");
    }

    #[test]
    fn hashtags_are_not_headings() {
        assert_eq!(title("#idea for later"), "#idea for later");
        assert_eq!(title("# Learning C#"), "Learning C#");
    }

    #[test]
    fn empty_bodies_have_no_title() {
        assert_eq!(title(""), "");
        assert_eq!(title("   \n\n  "), "");
        assert_eq!(title("```\n```"), "");
    }

    #[test]
    fn long_titles_are_cut_on_a_word() {
        let long = "word ".repeat(40);
        let t = title(&long);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 81);
        assert!(!t.contains("wor…"));
    }
}
