//! Query parsing and snippets for search (docs/design.md#search). The index
//! is SQLite FTS5 with the trigram tokenizer, so any term of three or more
//! characters matches anywhere inside a word.

use crate::{plain, title};

/// Splits a query into terms: quoted phrases stay whole, everything else
/// splits on whitespace.
pub fn terms(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = query.trim();
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('"') {
            let end = after.find('"').unwrap_or(after.len());
            let phrase = after[..end].trim();
            if !phrase.is_empty() {
                out.push(phrase.to_string());
            }
            rest = after.get(end + 1..).unwrap_or("").trim_start();
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            out.push(rest[..end].to_string());
            rest = rest[end..].trim_start();
        }
    }
    out
}

/// Terms long enough for the trigram index.
pub fn is_indexable(term: &str) -> bool {
    term.chars().count() >= 3
}

/// An FTS5 MATCH expression requiring every term, each as a quoted string so
/// FTS operators in user input are treated as text.
pub fn fts_expression(terms: &[String]) -> String {
    terms.iter().map(|t| format!("\"{}\"", t.replace('"', "\"\""))).collect::<Vec<_>>().join(" ")
}

/// A LIKE pattern matching `term` anywhere, escaped with `\`.
pub fn like_contains(term: &str) -> String {
    format!("%{}%", escape_like(term))
}

pub fn like_prefix(term: &str) -> String {
    format!("{}%", escape_like(term))
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Context kept on each side of the match, in bytes of plain text.
const BEFORE: usize = 40;
const AFTER: usize = 80;
/// How much markdown around the match is read to fill that context. More
/// than the context, because the syntax drops out.
const READ_BEFORE: usize = 120;
const READ_AFTER: usize = 200;
/// The read is widened to take in the whole of its first and last lines, so
/// their block markers can be recognized, unless a line runs on this far.
const LINE_SLACK: usize = 160;
/// How far a cut moves to land between words.
const WORD_SLACK: usize = 16;

/// Text around the first match of any term, on one line: each line's
/// markdown stripped the way titles strip it, table rows as their cells,
/// lines joined with " · ", and ellipses where it was cut. A match outside
/// the title line comes first, since the title is shown already; the title
/// is used only when nothing else matches.
pub fn snippet(body: &str, terms: &[String]) -> Option<String> {
    let lower = body.to_lowercase();
    let title = title::title_line(body).unwrap_or(0..0);
    let find = |term: &str, from: usize| lower.get(from..)?.find(&term.to_lowercase()).map(|i| from + i);
    let first = |skip_title: bool| {
        terms
            .iter()
            .filter_map(|t| {
                let i = find(t, 0)?;
                let i = if skip_title && title.contains(&i) { find(t, title.end)? } else { i };
                Some((i, t))
            })
            .min_by_key(|(i, _)| *i)
    };
    let (at, term) = first(true).or_else(|| first(false))?;
    // Lowercasing can change byte lengths for some scripts; only trust the
    // position when it maps back onto a char boundary in the original.
    if !body.is_char_boundary(at) {
        return None;
    }
    // Past the title, the snippet leaves it out of the context too.
    let floor = if at >= title.end { title.end } else { 0 };

    let mut from = floor_boundary(body, at.saturating_sub(READ_BEFORE)).max(floor);
    let first_line = body[..from].rfind('\n').map_or(0, |i| i + 1);
    let first_whole = from - first_line <= LINE_SLACK;
    if first_whole {
        from = first_line;
    }
    let mut to = floor_boundary(body, (at + term.len() + READ_AFTER).min(body.len()));
    match body[to..].find('\n') {
        Some(i) if i <= LINE_SLACK => to += i,
        None if body.len() - to <= LINE_SLACK => to = body.len(),
        _ => {}
    }

    // Whether the read starts inside a fenced code block, whose lines are
    // kept as written.
    let mut in_code = body[..first_line].lines().filter(|l| plain::is_fence(l)).count() % 2 == 1;
    let mut text = String::new();
    let mut anchor = None;
    let mut line_start = from;
    for (i, line) in body[from..to].split('\n').enumerate() {
        let whole = i > 0 || first_whole;
        let part = if whole && plain::is_fence(line) {
            in_code = !in_code;
            String::new()
        } else if in_code {
            plain::collapse_whitespace(line)
        } else if !whole {
            plain::fragment_text(line)
        } else if plain::is_rule(line) || plain::is_table_divider(line.trim()) {
            String::new()
        } else {
            plain::line_text(line, ", ")
        };
        if !part.is_empty() && !text.is_empty() {
            text.push_str(" · ");
        }
        line_start += line.len() + 1;
        if anchor.is_none() && at < line_start {
            // Where the term lands once the line's syntax is gone; the start
            // of the line if the term was part of the syntax.
            anchor = Some(text.len() + find_ignoring_case(&part, term).unwrap_or(0));
        }
        text.push_str(&part);
    }

    let anchor = anchor.unwrap_or(text.len());
    let match_end = floor_boundary(&text, (anchor + term.len()).min(text.len()));
    let mut start = floor_boundary(&text, anchor.saturating_sub(BEFORE));
    let mut end = floor_boundary(&text, (match_end + AFTER).min(text.len()));
    // Cut between words when there's a space nearby.
    if start > 0
        && !text[..start].ends_with(' ')
        && let Some(i) = text[start..anchor].find(' ').filter(|&i| i < WORD_SLACK)
    {
        start += i + 1;
    }
    if end < text.len()
        && !text[end..].starts_with(' ')
        && let Some(i) = text[match_end..end].rfind(' ').filter(|&i| end - (match_end + i) < WORD_SLACK)
    {
        end = match_end + i;
    }
    let mut s = text[start..end].trim_matches([' ', '·']).to_string();
    if s.is_empty() {
        return None;
    }
    if start > 0 || !body[floor..from].trim().is_empty() {
        s.insert(0, '…');
    }
    if end < text.len() || !body[to..].trim().is_empty() {
        s.push('…');
    }
    Some(s)
}

fn find_ignoring_case(text: &str, term: &str) -> Option<usize> {
    let i = text.to_lowercase().find(&term.to_lowercase())?;
    text.is_char_boundary(i).then_some(i)
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_keep_quoted_phrases() {
        assert_eq!(terms(r#"sync "rich copy" table"#), vec!["sync", "rich copy", "table"]);
        assert_eq!(terms(r#"  "unterminated phrase"#), vec!["unterminated phrase"]);
        assert!(terms("   ").is_empty());
    }

    #[test]
    fn fts_expression_quotes_everything() {
        assert_eq!(fts_expression(&["a\"b".into(), "NOT".into()]), r#""a""b" "NOT""#);
    }

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(like_contains("50%_off"), "%50\\%\\_off%");
        assert_eq!(like_prefix("ab"), "ab%");
    }

    #[test]
    fn snippet_centers_on_first_match() {
        let body = format!("{}needle here{}", "a ".repeat(50), " b".repeat(80));
        let s = snippet(&body, &["NEEDLE".into()]).unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle here"));
        assert!(snippet("nothing", &["missing".into()]).is_none());
    }

    #[test]
    fn snippet_handles_multibyte_text() {
        let body = "café ".repeat(30) + "résumé target " + &"naïve ".repeat(30);
        assert!(snippet(&body, &["target".into()]).unwrap().contains("target"));
        let body = format!("## Über\n\n{}\n\n- target\n\n{}", "é".repeat(90), "ü".repeat(90));
        assert!(snippet(&body, &["target".into()]).unwrap().contains("é · target · ü"));
    }

    #[test]
    fn snippet_strips_markdown_line_by_line() {
        let body =
            "## Sync\n\n| part | owner |\n| --- | --- |\n| **server** | [me](https://x) |\n\n- [ ] needle in a list\n";
        assert_eq!(snippet(body, &["needle".into()]).unwrap(), "part, owner · server, me · needle in a list");
        let body = "> quoted *needle*\n\n---\n\n1. first\n";
        assert_eq!(snippet(body, &["needle".into()]).unwrap(), "quoted needle · first");
    }

    #[test]
    fn snippet_prefers_a_match_outside_the_title() {
        let body = "# Sync notes\n\nWe need to resync the phone.";
        assert_eq!(snippet(body, &["sync".into()]).unwrap(), "We need to resync the phone.");
        assert_eq!(snippet(body, &["sync".into(), "notes".into()]).unwrap(), "We need to resync the phone.");
        let body = "\n---\n\n# Sync\n\nbody sync here";
        assert_eq!(snippet(body, &["sync".into()]).unwrap(), "body sync here");
        // Only the title matches, so it's the snippet.
        let body = "# Sync notes\n\nnothing else here";
        assert_eq!(snippet(body, &["sync".into()]).unwrap(), "Sync notes · nothing else here");
        // Text between the title and the match that's cut off still gets an ellipsis.
        let body = format!("# Sync\n\n{}resync", "- item\n".repeat(30));
        assert!(snippet(&body, &["sync".into()]).unwrap().starts_with("…item"));
    }

    #[test]
    fn snippet_cuts_the_plain_text_around_the_match() {
        let body = format!("# Title\n\n{}\n\n**the needle**\n\n{}", "- item\n".repeat(20), "- more\n".repeat(20));
        let s = snippet(&body, &["needle".into()]).unwrap();
        assert!(s.starts_with("…item · item") && s.ends_with("more · more…"), "{s}");
        assert!(s.contains("item · the needle · more"));
        assert!(!s.contains(['-', '*']));
    }

    #[test]
    fn snippet_keeps_code_as_written() {
        let body = "Setup\n\n```sh\n# install deps\nneedle --fast\n```\n";
        assert_eq!(snippet(body, &["needle".into()]).unwrap(), "# install deps · needle --fast");
        // The fence opens before the part of the text that's read.
        let body = format!("```\n{}# still code, needle\n```", "x = 1\n".repeat(60));
        assert!(snippet(&body, &["needle".into()]).unwrap().ends_with("x = 1 · # still code, needle"));
    }

    #[test]
    fn snippet_reads_part_of_a_long_line() {
        let body = format!("# Title\n\n{}a needle {}\n\n# Next", "word ".repeat(100), "word ".repeat(100));
        let s = snippet(&body, &["needle".into()]).unwrap();
        assert!(s.starts_with("…word") && s.ends_with("word…"), "{s}");
        assert!(!s.contains("Title") && !s.contains("Next"));
    }

    #[test]
    fn snippet_falls_back_to_the_line_when_the_match_was_syntax() {
        let body = "# Links\n\nSee [the docs](https://example.com/guide) first";
        assert_eq!(snippet(body, &["example.com".into()]).unwrap(), "See the docs first");
    }
}
