//! Markdown to HTML for "copy as rich text".

use crate::attachments::{Kind, SCHEME};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use comrak::nodes::NodeValue;
use comrak::{Arena, Options, format_html, parse_document};

/// GitHub-flavored HTML. Raw HTML in the draft is dropped rather than passed
/// through, since the output goes to other apps' clipboards.
pub fn to_html(markdown: &str) -> String {
    to_html_with(markdown, |_| None)
}

/// Like `to_html`, with each attachment inlined as a `data:` URL, so the
/// images go wherever the HTML is pasted. `load` gives an attachment's
/// format and bytes, or None to leave its link as it is.
pub fn to_html_with(markdown: &str, load: impl Fn(&str) -> Option<(Kind, Vec<u8>)>) -> String {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    for node in root.descendants() {
        if let NodeValue::Image(link) = &mut node.data.borrow_mut().value
            && let Some((kind, bytes)) = link.url.strip_prefix(SCHEME).and_then(&load)
        {
            link.url = format!("data:{};base64,{}", kind.mime(), B64.encode(bytes));
        }
    }
    let mut html = String::new();
    format_html(root, &options, &mut html).expect("writing to a string");
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::PIXEL;

    #[test]
    fn renders_tables_and_strips_raw_html() {
        let html = to_html("| a | b |\n| - | - |\n| 1 | 2 |\n\n<script>x</script>");
        assert!(html.contains("<table>"));
        assert!(html.contains("<td>1</td>"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn inlines_attachments() {
        let md = "![a pixel](attachment:0123456789abcdef0123456789abcdef.png)\n\n![](attachment:missing.png)";
        let html = to_html_with(md, |name| name.starts_with("0123").then(|| (Kind::Png, PIXEL.to_vec())));
        assert!(
            html.contains(&format!("src=\"data:image/png;base64,{}\" alt=\"a pixel\"", B64.encode(PIXEL))),
            "{html}"
        );
        assert!(html.contains("src=\"attachment:missing.png\""), "{html}");
    }
}
