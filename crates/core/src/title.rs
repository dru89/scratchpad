//! Titles come from the first line of the body that has text, with markdown
//! syntax stripped (docs/design.md#drafts). Block markers are removed per
//! line; inline syntax goes through a real markdown parser, so escapes, code
//! spans, and links come out right.

use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};

const MAX_CHARS: usize = 80;
const MAX_LINES_SCANNED: usize = 200;

/// Returns the draft's title, or an empty string when the body has no text.
pub fn title(body: &str) -> String {
    for line in body.lines().take(MAX_LINES_SCANNED) {
        let line = line.trim();
        if line.is_empty() || is_fence(line) || is_rule(line) || is_table_divider(line) {
            continue;
        }
        let text = collapse_whitespace(&inline_text(strip_block_markers(line)));
        if !text.is_empty() {
            return truncate(&text);
        }
    }
    String::new()
}

fn is_fence(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

/// `---`, `***`, `___` (spaces allowed), and setext underlines (`===`).
fn is_rule(line: &str) -> bool {
    let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    chars.len() >= 3 && ['-', '*', '_', '='].iter().any(|m| chars.iter().all(|c| c == m))
}

/// A table's `| --- | :---: |` row.
fn is_table_divider(line: &str) -> bool {
    line.contains('-') && line.contains('|') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

fn strip_block_markers(mut line: &str) -> &str {
    loop {
        let before = line;
        line = line.trim_start();
        if let Some(rest) = line.strip_prefix('>') {
            line = rest;
        } else if let Some(rest) = strip_heading(line) {
            line = rest;
        } else if let Some(rest) = strip_list_marker(line) {
            line = rest;
        } else if let Some(rest) = strip_task_box(line) {
            line = rest;
        }
        if line == before {
            break;
        }
    }
    let line = line.trim();
    // A table row: drop the outer pipes, keep the inner ones.
    let line = line.strip_prefix('|').unwrap_or(line);
    let line = line.strip_suffix('|').unwrap_or(line);
    line.trim()
}

fn strip_heading(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None; // "#hashtag" isn't a heading
    }
    // Drop a closing sequence ("## Title ##"), but only after whitespace, so
    // "# C#" keeps its hash.
    let rest = rest.trim_end();
    let without = rest.trim_end_matches('#');
    if without.len() < rest.len() && (without.is_empty() || without.ends_with([' ', '\t'])) {
        Some(without)
    } else {
        Some(rest)
    }
}

fn strip_list_marker(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest);
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if (1..=9).contains(&digits) {
        let rest = &line[digits..];
        for marker in [". ", ") "] {
            if let Some(rest) = rest.strip_prefix(marker) {
                return Some(rest);
            }
        }
    }
    None
}

fn strip_task_box(line: &str) -> Option<&str> {
    for marker in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest);
        }
    }
    None
}

/// Plain text of one line of inline markdown.
fn inline_text(line: &str) -> String {
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    let root = parse_document(&arena, line, &options);
    let mut out = String::new();
    for node in root.descendants() {
        match &node.data.borrow().value {
            NodeValue::Text(t) => out.push_str(t),
            NodeValue::Code(c) => out.push_str(&c.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {}
        }
    }
    out
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
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
