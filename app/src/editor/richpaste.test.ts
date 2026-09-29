// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown as md } from './richpaste';

describe('htmlToMarkdown', () => {
  it('reads Google Docs, whose formatting is in styles', () => {
    const docs =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="margin-top:0pt;margin-bottom:0pt;">' +
      '<span style="font-size:11pt;font-weight:700;">Bold</span><span style="font-size:11pt;font-weight:400;"> and </span>' +
      '<span style="font-weight:400;font-style:italic;">italic</span></p><br>' +
      '<ul><li dir="ltr" style="list-style-type:disc;"><p dir="ltr"><span>one</span></p></li><li><p><span>two</span></p></li></ul></b>';
    expect(md(docs)).toBe('**Bold** and *italic*\n\n- one\n- two');
  });

  it('writes headings, links, code and strikethrough', () => {
    const html =
      '<h2>Plan <b>now</b></h2><p>See <a href="https://x.com/a_b">the doc</a> and <a href="https://x.com">https://x.com</a>, ' +
      'run <code>npm i</code>, <del>old</del>, <a href="https://x.com/a (b)">paren</a>, <a href="#top">here</a>.</p>';
    expect(md(html)).toBe(
      '## Plan now\n\nSee [the doc](https://x.com/a_b) and https://x.com, run `npm i`, ~~old~~, [paren](<https://x.com/a (b)>), here.',
    );
  });

  it('makes tables of data into markdown tables, the first row as the header', () => {
    expect(md('<table><tr><td>Name</td><td>Owner</td></tr><tr><td>Sync | server</td><td><b>Sam</b></td></tr></table>')).toBe(
      '| Name | Owner |\n| --- | --- |\n| Sync \\| server | **Sam** |',
    );
    expect(md('<table><thead><tr><th colspan="2">Wide</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>')).toBe(
      '| Wide |  | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
    );
    // A column from a spreadsheet, or an email laid out with tables, is text.
    expect(md('<table><tr><td>alpha</td></tr><tr><td>beta</td></tr></table>')).toBe('alpha\nbeta');
    expect(md('<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>')).toBe('| a | b |\n| --- | --- |');
  });

  it('nests lists with tabs, keeping numbers and tasks', () => {
    const html =
      '<ol start="3"><li>a<ul><li>b</li></ul></li><li>c</li></ol>' +
      '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>' +
      '<ul><li>x</li><ul><li>stray nested</li></ul></ul>';
    expect(md(html)).toBe('3. a\n\t- b\n4. c\n\n- [x] done\n- [ ] todo\n\n- x\n\t- stray nested');
  });

  it('reads Word lists, which are paragraphs', () => {
    const word =
      "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>First</p>" +
      "<p style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o<span>&nbsp;</span></span>Nested</p>" +
      "<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·</span>Second</p><p>After</p>" +
      "<p style='mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span>Numbered</p>";
    expect(md(word)).toBe('- First\n\t- Nested\n- Second\n\nAfter\n\n1. Numbered');
  });

  it('writes quotes, code blocks and rules', () => {
    const html =
      '<blockquote><p>quoted</p><p>more</p></blockquote><pre><code class="language-ts">const a = 1;\nconst b = `x`;\n</code></pre><hr><p>end</p>';
    expect(md(html)).toBe('> quoted\n>\n> more\n\n```ts\nconst a = 1;\nconst b = `x`;\n```\n\n---\n\nend');
  });

  it('escapes only what would read as markdown', () => {
    const html = '<p>5 * 3 and *not bold* snake_case _x_ # not a heading C:\\Users</p><p>- not a list</p><p>1. not a list</p><p>&lt;b&gt;</p>';
    expect(md(html)).toBe('5 * 3 and \\*not bold\\* snake_case \\_x\\_ # not a heading C:\\Users\n\n\\- not a list\n\n1\\. not a list\n\n\\<b>');
  });

  it('collapses whitespace and merges formatting that continues', () => {
    expect(md('<p>  a   <b> b </b>  c</p>')).toBe('a **b** c');
    expect(md('<span style="font-weight:700">a</span><span style="font-weight:700;font-style:italic">b</span>')).toBe('**a*b***');
    expect(md('<b>one</b> <b>two</b>')).toBe('**one two**');
    expect(md('<p>a&nbsp;&nbsp;b</p>')).toBe('a b');
  });

  it('treats divs as lines and paragraphs as paragraphs', () => {
    expect(md('<div>one</div><div>two</div>')).toBe('one\ntwo');
    expect(md('<p>a<br>b</p><p>c</p>')).toBe('a\nb\n\nc');
  });

  it('keeps remote images as links and leaves out embedded ones', () => {
    expect(md('<p>Look <img src="https://x.com/a.png" alt="chart"> <img src="data:image/png;base64,AAAA"></p>')).toBe(
      'Look ![chart](https://x.com/a.png)',
    );
  });

  it('leaves out what a page hides and what it runs', () => {
    expect(md('<style>p{color:red}</style><p>shown<span style="display:none">hidden</span></p><script>x()</script>')).toBe('shown');
  });

  it('gives up on a copy from a code editor, whose plain text is the point', () => {
    const vscode =
      '<meta charset="utf-8"><div style="color: #d4d4d4;font-family: Menlo, Monaco, monospace;white-space: pre;"><div><span style="color: #569cd6;">const</span> x = 1;</div></div>';
    expect(md(vscode)).toBeNull();
    expect(md('<code>npm install</code>')).toBeNull();
    expect(md('<p></p>')).toBeNull();
  });
});
