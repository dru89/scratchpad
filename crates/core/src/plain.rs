//! Plain text from markdown, a line at a time, for titles and search
//! snippets. Block markers are removed by hand; inline syntax goes through a
//! real markdown parser, so escapes, code spans, and links come out right.

use comrak::nodes::NodeValue;
use comrak::{Arena, Options, parse_document};

/// The text of one line with its markdown removed. A table row becomes its
/// non-empty cells joined with `cell_sep`.
pub(crate) fn line_text(line: &str, cell_sep: &str) -> String {
    let line = strip_block_markers(line);
    match table_cells(line) {
        Some(cells) => cells
            .into_iter()
            .map(|c| collapse_whitespace(&inline_text(c)))
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>()
            .join(cell_sep),
        None => collapse_whitespace(&inline_text(line)),
    }
}

/// Like `line_text`, for text that starts partway through a line, where
/// block markers can't be recognized.
pub(crate) fn fragment_text(fragment: &str) -> String {
    collapse_whitespace(&inline_text(fragment.trim_start()))
}

pub(crate) fn is_fence(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("```") || line.starts_with("~~~")
}

/// `---`, `***`, `___` (spaces allowed), and setext underlines (`===`).
pub(crate) fn is_rule(line: &str) -> bool {
    let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    chars.len() >= 3 && ['-', '*', '_', '='].iter().any(|m| chars.iter().all(|c| c == m))
}

/// A table's `| --- | :---: |` row.
pub(crate) fn is_table_divider(line: &str) -> bool {
    line.contains('-') && line.contains('|') && line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

pub(crate) fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
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

/// The cells of a table row: a line that starts or ends with a pipe. Cells
/// split the way the app's table widget splits them (app/src/editor/tables.ts),
/// so escaped pipes and pipes inside code stay in their cell.
fn table_cells(line: &str) -> Option<Vec<&str>> {
    let closed = |s: &str| s.ends_with('|') && !s.ends_with("\\|");
    if !line.starts_with('|') && !closed(line) {
        return None;
    }
    let inner = line.strip_prefix('|').unwrap_or(line);
    let inner = if closed(inner) { &inner[..inner.len() - 1] } else { inner };
    let mut cells = Vec::new();
    let mut start = 0;
    let mut in_code = false;
    let mut chars = inner.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '`' => in_code = !in_code,
            '|' if !in_code => {
                cells.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    cells.push(&inner[start..]);
    Some(cells)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_rows_become_cells() {
        assert_eq!(line_text("| **server** | [me](https://x) |", ", "), "server, me");
        assert_eq!(line_text("a | b |", ", "), "a, b");
        assert_eq!(line_text("| a |  | c |", ", "), "a, c");
        assert_eq!(line_text(r"| a \| b | `x|y` |", ", "), "a | b, x|y");
        assert_eq!(line_text("> | quoted | row |", ", "), "quoted, row");
    }

    #[test]
    fn pipes_inside_text_are_not_tables() {
        assert_eq!(line_text("this | that", ", "), "this | that");
        assert_eq!(line_text(r"ends with \|", ", "), "ends with |");
    }
}
