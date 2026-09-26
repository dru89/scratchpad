//! Markdown to HTML for "copy as rich text".

use comrak::{Options, markdown_to_html};

/// GitHub-flavored HTML. Raw HTML in the draft is dropped rather than passed
/// through, since the output goes to other apps' clipboards.
pub fn to_html(markdown: &str) -> String {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    markdown_to_html(markdown, &options)
}

#[cfg(test)]
mod tests {
    use super::to_html;

    #[test]
    fn renders_tables_and_strips_raw_html() {
        let html = to_html("| a | b |\n| - | - |\n| 1 | 2 |\n\n<script>x</script>");
        assert!(html.contains("<table>"));
        assert!(html.contains("<td>1</td>"));
        assert!(!html.contains("<script>"));
    }
}
