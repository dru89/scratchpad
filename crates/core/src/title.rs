//! Titles come from the first line of the body that has text, with markdown
//! syntax stripped (docs/design.md#drafts), and previews from the text after
//! it. The stripping is in plain.rs, shared with search snippets.

use std::ops::Range;

use crate::plain::{collapse_whitespace, is_fence, is_rule, is_table_divider, line_text};

const MAX_CHARS: usize = 80;
/// Longer than the two lines the sidebar shows, so a wider sidebar fills too.
const PREVIEW_CHARS: usize = 240;
const MAX_LINES_SCANNED: usize = 200;

/// Returns the draft's title, or an empty string when the body has no text.
pub fn title(body: &str) -> String {
    first_text_line(body).map(|(_, text)| truncate(&text)).unwrap_or_default()
}

/// The byte range of the line the title comes from, including its newline.
pub fn title_line(body: &str) -> Option<Range<usize>> {
    first_text_line(body).map(|(range, _)| range)
}

fn first_text_line(body: &str) -> Option<(Range<usize>, String)> {
    let mut end = 0;
    for raw in body.split_inclusive('\n').take(MAX_LINES_SCANNED) {
        let start = end;
        end += raw.len();
        let line = raw.trim();
        if line.is_empty() || is_fence(line) || is_rule(line) || is_table_divider(line) {
            continue;
        }
        let text = line_text(line, " | ");
        if !text.is_empty() {
            return Some((start..end, text));
        }
    }
    None
}

/// The text after the title line, the way search snippets show text: each
/// line's markdown stripped, table rows as their cells, fenced code as
/// written, lines joined with " · ". Empty for a draft that's only a title.
pub fn preview(body: &str) -> String {
    let Some(title) = title_line(body) else { return String::new() };
    let mut in_code = body[..title.start].lines().filter(|l| is_fence(l)).count() % 2 == 1;
    let mut out = String::new();
    for line in body[title.end..].lines() {
        let part = if is_fence(line) {
            in_code = !in_code;
            continue;
        } else if in_code {
            collapse_whitespace(line)
        } else if is_rule(line) || is_table_divider(line.trim()) {
            continue;
        } else {
            line_text(line, ", ")
        };
        if part.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str(" · ");
        }
        out.push_str(&part);
        if out.chars().count() > PREVIEW_CHARS {
            break;
        }
    }
    cut(&out, PREVIEW_CHARS)
}

fn truncate(s: &str) -> String {
    cut(s, MAX_CHARS)
}

/// `s` cut to `max` characters with an ellipsis, on a word if one is close.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if cut[..i].chars().count() >= max * 3 / 4 => &cut[..i],
        _ => &cut[..],
    };
    format!("{}…", cut.trim_end_matches([' ', '·']))
}

#[cfg(test)]
mod tests {
    use super::{preview, title, title_line};

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
    fn title_line_is_where_the_title_came_from() {
        let body = "\n---\n\n# Title\nbody";
        assert_eq!(&body[title_line(body).unwrap()], "# Title\n");
        assert_eq!(title_line("only line"), Some(0..9));
        assert_eq!(title_line("  \n"), None);
    }

    #[test]
    fn previews_are_the_text_after_the_title() {
        let body = "# Plan\n\nThree **things** to settle.\n\n| Area | Owner |\n| --- | --- |\n| Sync | Priya |\n\n- [ ] ship it";
        assert_eq!(preview(body), "Three things to settle. · Area, Owner · Sync, Priya · ship it");
        assert_eq!(preview("Just a title"), "");
        assert_eq!(preview(""), "");
        assert_eq!(preview("Setup\n```sh\n# install deps\n```"), "# install deps");
    }

    #[test]
    fn long_previews_are_cut_on_a_word() {
        let p = preview(&format!("Title\n{}", "word ".repeat(100)));
        assert!(p.ends_with('…') && p.chars().count() <= 241, "{p}");
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
