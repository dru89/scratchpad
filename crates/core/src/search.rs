//! Query parsing and snippets for search (docs/design.md#search). The index
//! is SQLite FTS5 with the trigram tokenizer, so any term of three or more
//! characters matches anywhere inside a word.

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

/// Text around the first match of any term, on one line, with ellipses where
/// it was cut.
pub fn snippet(body: &str, terms: &[String]) -> Option<String> {
    let lower = body.to_lowercase();
    // Lowercasing can change byte lengths for some scripts; only trust the
    // position when it maps back onto a char boundary in the original.
    let (at, len) =
        terms.iter().filter_map(|t| lower.find(&t.to_lowercase()).map(|i| (i, t.len()))).min_by_key(|(i, _)| *i)?;
    if !body.is_char_boundary(at) {
        return None;
    }
    let start = floor_boundary(body, at.saturating_sub(40));
    let end = floor_boundary(body, (at + len + 80).min(body.len()));
    let mut s = body[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < body.len() {
        s.push('…');
    }
    Some(s)
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
    }
}
