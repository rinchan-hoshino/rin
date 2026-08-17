import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const richText = await importBuiltModule<
  typeof import("../../src/core/chat/rich-text.js")
>("dist/core/chat/rich-text.js");

test("rich text chooses the platform markdown contract", () => {
  assert.equal(richText.chatMarkdownPolicyForPlatform(" Telegram "), "render");
  assert.equal(richText.chatMarkdownPolicyForPlatform("DISCORD"), "preserve");
  assert.equal(richText.chatMarkdownPolicyForPlatform("example"), "strip");
});

test("rich text removes HTML and Markdown presentation without losing content", () => {
  assert.equal(
    richText.stripHtmlFormatting(
      "<p>A&amp;B<br>C&nbsp;&lt;x&gt;&quot;q&quot;&#39;s&#39;</p><script>tail</script>",
    ),
    "A&B\nC <x>\"q\"'s'\ntail",
  );
  assert.equal(
    richText.stripMarkdownFormatting(
      "# **Title**\n> _quote_\n* item\n1) first\n`code` ~~old~~ [link](https://x) ![alt](img.png)",
    ),
    "Title\n> quote\n- item\n1. first\ncode old link [image: alt]",
  );
  assert.equal(
    richText.stripMarkdownFormatting(
      "```ts\nconst x = 1;\n``` ![](fallback.png)",
    ),
    "const x = 1;\n [image: fallback.png]",
  );
  assert.equal(richText.normalizeRenderedText(" \r\n\t\r\n "), "");
  assert.equal(
    richText.normalizeRenderedText("\n  alpha  \n beta \n"),
    "  alpha\n beta",
  );
});

test("rich nodes render text, references, media, and checklist boundaries", () => {
  const nodes = [
    null,
    "prefix ",
    4,
    { type: "text", text: "plain " },
    { type: "md", attrs: { value: "**bold** " } },
    { type: "html", attrs: { content: "<b>html</b>" } },
    { type: "br" },
    { type: "at", attrs: { id: "42", name: "Rin" } },
    { type: "at", attrs: { name: "name-only" } },
    { type: "at", attrs: {} },
    {
      type: "quote",
      attrs: { messageId: "m1" },
      children: [{ type: "text", attrs: { content: "line1\nline2" } }],
    },
    { type: "quote", children: [] },
    {
      type: "forward",
      attrs: { title: "Thread", id: "f1" },
      children: [{ type: "text", content: "inside" }],
    },
    { type: "forward", attrs: {}, children: [] },
    { type: "img", attrs: { src: "a.png", title: "cover" } },
    { type: "file", attrs: { url: "f.zip", fileName: "archive" } },
    { type: "audio", attrs: {} },
    { type: "video", attrs: { file: "v.mp4" } },
    { type: "voice", attrs: { name: "voice" } },
    { type: "sticker", attrs: { src: "s.webp" } },
    { type: "record", attrs: { src: "r.ogg" } },
    {
      type: "todo",
      attrs: {
        title: "Plan",
        items: [
          { text: " first  item ", done: false },
          null,
          { text: "", done: true },
          { text: "done", done: true },
        ],
      },
    },
    { type: "checklist", attrs: { todos: [{ text: "next", done: false }] } },
    { type: "paragraph", children: [{ type: "text", text: "paragraph" }] },
    { type: "p", children: [] },
    { type: "unknown", children: [{ type: "text", text: "child" }] },
  ];

  const markdown = richText.renderChatNodesMarkdown(nodes as any[], {
    renderAt: (attrs) => `mention:${attrs.id || attrs.name || "none"}`,
  });
  for (const expected of [
    "prefix plain **bold** html",
    "mention:42mention:name-onlymention:none",
    "[quote:m1]",
    "> line1",
    "[forward: Thread: f1]",
    "[forward]",
    "[image: cover](a.png)",
    "[file: archive](f.zip)",
    "[audio: audio]",
    "Plan",
    "⬜ first item",
    "✅ ~~done~~",
    "paragraph",
    "child",
  ]) {
    assert.match(
      markdown,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.equal(
    richText.renderChatNodesMarkdown([
      { type: "at", attrs: { id: "42", name: "Rin" } },
      { type: "at", attrs: { name: "name-only" } },
      { type: "at", attrs: {} },
    ]),
    "[@Rin](at:42)@name-only@",
  );
  assert.equal(
    richText.renderChatNodesMarkdown(
      [{ type: "image", attrs: { src: "hidden.png" } }],
      { includeMedia: false },
    ),
    "",
  );
  assert.equal(
    richText.renderChatNodesPlain([{ type: "markdown", text: "**bold**" }]),
    "bold",
  );
  assert.equal(
    richText.renderChatNodesPlain([{ type: "markdown", text: "**bold**" }], {
      markdown: "preserve",
    }),
    "**bold**",
  );
});

test("rich syntax expands only unprotected markdown references", () => {
  const expanded = richText.expandRichTextSyntaxNodes([
    false,
    "raw",
    {
      type: "markdown",
      attrs: {
        content:
          "before ![cover](image.png) [@Rin](at:42) [quoted](quote:m1) [file: doc](doc.pdf) [quote: m2] `![literal](code.png)`\n```md\n[@No](at:0)\n``` after",
      },
    },
    {
      type: "section",
      children: [{ type: "md", content: "[image: nested](nested.png)" }],
    },
    { type: "text", text: "tail" },
  ] as any[]);

  const topTypes = expanded.map((node: any) => node?.type || node);
  assert.deepEqual(topTypes.slice(0, 7), [
    "raw",
    "markdown",
    "image",
    "at",
    "quote",
    "file",
    "quote",
  ]);
  assert.ok(expanded.some((node: any) => node?.type === "file"));
  assert.ok(expanded.filter((node: any) => node?.type === "quote").length >= 2);
  const protectedText = expanded
    .filter((node: any) => node?.type === "markdown")
    .map((node: any) => node.attrs?.content)
    .join("");
  assert.match(protectedText, /!\[literal\]\(code\.png\)/);
  assert.match(protectedText, /\[@No\]\(at:0\)/);
  const nested = expanded.find((node: any) => node?.type === "section");
  assert.equal(nested.children[0].type, "image");

  assert.deepEqual(
    richText.expandRichTextSyntaxNodes([{ type: "md", content: "plain" }]),
    [{ type: "markdown", attrs: { content: "plain" }, children: [] }],
  );

  const fileUrl = "file:///tmp/reference.txt";
  const attachmentAuthority = richText.expandRichTextSyntaxNodes([
    {
      type: "markdown",
      content: [
        `bare ${fileUrl}`,
        `[reference](${fileUrl})`,
        `[file: attached](${fileUrl})`,
      ].join("\n"),
    },
  ]);
  assert.equal(
    attachmentAuthority.filter((node: any) => node?.type === "file").length,
    1,
  );
  assert.equal(
    attachmentAuthority.find((node: any) => node?.type === "file")?.attrs?.src,
    fileUrl,
  );
  assert.match(
    attachmentAuthority
      .filter((node: any) => node?.type === "markdown")
      .map((node: any) => node.attrs?.content)
      .join(""),
    /bare file:\/\/\/tmp\/reference\.txt[\s\S]*\[reference\]\(file:\/\/\/tmp\/reference\.txt\)/,
  );
  assert.deepEqual(richText.expandRichTextSyntaxNodes(null as any), []);
});

test("Telegram rendering escapes unsafe input and preserves supported markup", () => {
  assert.equal(
    richText.markdownToTelegramHtml(
      "# Head\n**bold** __also__ *ital* _too_ ~~gone~~ `a<b`\n> quote\n[site](https://example.test/?a=1&b=2) ![pic](x.png)\n```js\n<x>&\n```",
    ),
    '<b>Head</b>\n<b>bold</b> <b>also</b> <i>ital</i> <i>too</i> <s>gone</s> <code>a&lt;b</code>\n<blockquote>quote</blockquote>\n<a href="https://example.test/?a=1&amp;amp;b=2">site</a> [image: pic]\n<pre>&lt;x&gt;&amp;\n</pre>',
  );

  const html = richText.renderChatNodesTelegramHtml([
    {
      type: "html",
      attrs: {
        content:
          '<b>ok</b><script>bad</script><a onclick="x" href="https://x.test?a=1&b=2">x</a><a>plain</a>',
      },
    },
    { type: "markdown", content: " **m**" },
    { type: "at", attrs: { id: "1'2", name: "<Rin>" } },
    { type: "at", attrs: { username: "fallback" } },
    { type: "at", attrs: {} },
    {
      type: "quote",
      attrs: { id: "q1" },
      children: [{ type: "text", text: "body" }],
    },
  ]);
  assert.match(html, /<b>ok<\/b>bad/);
  assert.doesNotMatch(html, /script|onclick/);
  assert.match(html, /href="https:\/\/x\.test\?a=1&amp;b=2"/);
  assert.match(html, /<a>plain<\/a>/);
  assert.match(html, /<b>m<\/b>/);
  assert.match(html, /tg:\/\/user\?id=1&#39;2/);
  assert.match(html, /&lt;Rin&gt;/);
  assert.match(html, /fallback/);
});
