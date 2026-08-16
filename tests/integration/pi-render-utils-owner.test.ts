import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import * as render from "../../dist/core/pi/render-utils.js";
import { getCoreToolRenderer } from "../../dist/core/rin-tui/tool-renderers/index.js";

initTheme("dark", false);

const theme = {
  fg(kind: string, text: string) {
    return `<${kind}>${text}</${kind}>`;
  },
  bold(text: string) {
    return `**${text}**`;
  },
};

const lineTruncation = {
  truncated: true,
  truncatedBy: "lines" as const,
  outputLines: 2,
  totalLines: 5,
  maxLines: 2,
};

const byteTruncation = {
  truncated: true,
  truncatedBy: "bytes" as const,
  outputLines: 3,
  totalLines: 7,
  maxBytes: 1024,
};

test("render utilities normalize paths, scalar text, and call headers", () => {
  assert.equal(render.shortenPath(42), "");
  assert.equal(render.shortenPath("/outside/home"), "/outside/home");
  assert.equal(render.shortenPath(`${os.homedir()}/demo`), "~/demo");
  assert.equal(render.str("text"), "text");
  assert.equal(render.str(undefined), "");
  assert.equal(render.str({ text: "ignored" }), null);
  assert.equal(render.replaceTabs("a\tb"), "a   b");
  assert.deepEqual(render.trimTrailingEmptyLines(["a", "", ""]), ["a"]);
  assert.deepEqual(render.trimTrailingEmptyLines([]), []);

  assert.equal(render.formatHiddenResultsNotice(3, 0), "");
  assert.equal(
    render.formatHiddenResultsNotice(2, 9),
    "[Showing top 0 of 2 results.]",
  );
  assert.equal(render.getToolCallDisplayPrefix(" bash "), "$");
  assert.equal(render.getToolCallDisplayPrefix(""), "tool");
  assert.equal(render.getToolCallDisplayPrefix("recall"), "recall");
  assert.equal(
    render.formatToolCallLine("bash", " npm test ", theme, {
      detailStyle: "muted",
      suffix: "!",
    }),
    "<toolTitle>**$**</toolTitle> <muted>npm test</muted>!",
  );
  assert.equal(
    render.formatToolCallLine("read", "", theme),
    "<toolTitle>**read**</toolTitle>",
  );
  assert.equal(render.invalidArgText(theme), "<error>[invalid arg]</error>");
  assert.equal(getCoreToolRenderer(undefined), undefined);
  assert.equal(getCoreToolRenderer(" missing "), undefined);
  assert.equal(getCoreToolRenderer("todo")?.name, "todo");
});

test("render utilities collect safe text and image fallbacks", () => {
  assert.equal(render.getTextOutput(undefined, false), "");
  assert.equal(
    render.getTextOutput(
      {
        content: [
          { type: "text", text: "alpha\u0000\u001b[31mred\u001b[0m\r" },
          { type: "other", text: "ignored" },
          { type: "text", text: "beta" },
        ],
      },
      false,
    ),
    "alphared\nbeta",
  );
  const imageOnly = render.getTextOutput(
    { content: [{ type: "image" }] },
    false,
  );
  assert.match(imageOnly, /image\/unknown/i);
  const mixed = render.getTextOutput(
    {
      content: [
        { type: "text", text: "caption" },
        { type: "image", mimeType: "image/png", data: "not-an-image" },
      ],
    },
    true,
  );
  assert.match(mixed, /^caption(?:\n|$)/);

  assert.equal(render.getToolResultText({ content: [] }, false), "(no output)");
  assert.equal(
    render.getToolResultText({ content: [] }, false, "empty"),
    "empty",
  );
  assert.equal(
    render.getToolResultUserText(
      { content: [{ type: "text", text: "agent" }] },
      false,
      "owner",
    ),
    "owner",
  );
  assert.equal(
    render.getToolResultUserText(
      { content: [{ type: "text", text: "agent" }] },
      false,
      { text: "ignored" },
    ),
    "agent",
  );
  assert.deepEqual(
    render.buildUserFacingTextResult({ content: [] }, false, {
      fallback: "none",
      details: { hidden: 2 },
    }),
    {
      content: [{ type: "text", text: "none" }],
      details: { hidden: 2 },
    },
  );
  assert.deepEqual(render.buildUserFacingTextResult(undefined, false), {
    content: [{ type: "text", text: "(no output)" }],
    details: {},
  });
});

test("render utilities style each structured output family", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /^$/],
    ["   ", /^$/],
    ["[Showing 2 of 4 lines.]", /^<warning>/],
    ["No matches", /^<muted>/],
    ["(no output)", /^<muted>/],
    ["Error: broken", /^<error>/],
    ["Browse failed: denied", /^<error>/],
    ["1. Owner result | today", /<toolTitle>\*\*Owner result\*\*/],
    ["2. Result", /<muted>2\. <\/muted>/],
    ["browse 4", /<success>4<\/success>/],
    ["match 2", /^<toolTitle>/],
    ["url=https://example.test", /<accent>https:\/\/example\.test<\/accent>/],
    ["path= /tmp/file", /<accent>\/tmp\/file<\/accent>/],
    ["win=C:\\Temp\\file", /<accent>C:\\Temp\\file<\/accent>/],
    ["state=ok", /<success>ok<\/success>/],
    ["state=failed now", /<error>failed now<\/error>/],
    ["date=2026-07-17", /<muted>2026-07-17<\/muted>/],
    ["empty=   ", /<dim>=<\/dim> {3}$/],
    ["Saved task: complete", /<toolTitle>\*\*Saved task:\*\*/],
    ["https://example.test", /^<toolTitle>\*\*https:\*\*/],
    ["- first", /^<toolTitle>- <\/toolTitle>/],
    ["ordinary output", /^<toolOutput>/],
  ];
  for (const [input, pattern] of cases) {
    assert.match(render.styleToolOutputLine(input, theme), pattern, input);
  }
  assert.match(
    render.styleToolOutputLine("https://example.test | not indexed", theme),
    /^<toolTitle>\*\*https:\*\*/,
  );
});

test("render utilities describe duration and each truncation mode", () => {
  assert.equal(render.formatToolDuration(undefined, 10), undefined);
  assert.equal(render.formatToolDuration(1000, 3250), "Took 2.3s");
  const elapsed = render.formatToolDuration(Date.now() - 100);
  assert.match(elapsed || "", /^Elapsed 0\.[01]s$/);

  assert.equal(
    render.formatTruncationWarningMessage(lineTruncation as any),
    "Truncated: showing 2 of 5 lines (2 line limit)",
  );
  assert.equal(
    render.formatTruncationNotice(byteTruncation as any),
    "[Showing 3 of 7 lines (1.0KB limit).]",
  );
  const firstLine = {
    ...byteTruncation,
    firstLineExceedsLimit: true,
    maxBytes: undefined,
  };
  assert.match(
    render.formatTruncationWarningMessage(firstLine as any),
    /^First line exceeds /,
  );
  assert.equal(render.appendTruncationNotice("plain", undefined), "plain");
  assert.equal(
    render.appendTruncationNotice("", lineTruncation as any),
    "[Showing 2 of 5 lines.]",
  );
  assert.match(
    render.appendTruncationNotice("head", byteTruncation as any),
    /^head\n\n\[Showing 3 of 7 lines/,
  );

  const short = render.prepareTruncatedText("one line");
  assert.deepEqual(short, {
    outputText: "one line",
    previewText: "one line",
    truncation: undefined,
  });
  const truncated = render.prepareTruncatedText("one\ntwo\nthree", {
    maxLines: 2,
  });
  assert.ok(truncated.truncation);
  assert.match(truncated.outputText, /Showing 2 of 3 lines/);

  const same = render.prepareTruncatedAgentUserText(
    "one\ntwo\nthree",
    "one\ntwo\nthree",
    { maxLines: 2 },
  );
  assert.equal(same.userPreviewText, same.previewText);
  assert.equal(same.userTruncation, same.truncation);
  const different = render.prepareTruncatedAgentUserText(
    "agent short",
    "owner\ntext\nlong",
    { maxLines: 2 },
  );
  assert.equal(different.previewText, "agent short");
  assert.ok(different.userTruncation);
});

test("expandable result component renders expanded, collapsed, warning, and cache states", () => {
  const expanded = new render.ExpandableTextResultComponent();
  render.rebuildExpandableTextResultComponent(
    expanded,
    {
      outputText: "browse 2\npath=/tmp/result",
      expanded: true,
      fullOutputPath: "/tmp/full.log",
      truncation: lineTruncation as any,
      startedAt: 1000,
      endedAt: 2500,
    },
    theme,
  );
  const expandedText = expanded.render(120).join("\n");
  assert.match(expandedText, /browse/);
  assert.match(expandedText, /Full output: \/tmp\/full\.log/);
  assert.match(expandedText, /Truncated: showing 2 of 5 lines/);
  assert.match(expandedText, /Took 1\.5s/);

  const collapsed = new render.ExpandableTextResultComponent();
  render.rebuildExpandableTextResultComponent(
    collapsed,
    {
      outputText: "first\nsecond\nthird\nfourth",
      expanded: false,
      previewLines: 2,
    },
    theme,
  );
  const child = (collapsed as any).children[0];
  const firstRender = child.render(80);
  assert.match(firstRender.join("\n"), /earlier lines/);
  assert.deepEqual(child.render(80), firstRender);
  assert.ok(child.render(40).length >= 2);
  child.invalidate();
  assert.equal(collapsed.state.cachedWidth, undefined);
  assert.ok(child.render(80).length >= 2);

  const compact = new render.ExpandableTextResultComponent();
  render.rebuildExpandableTextResultComponent(
    compact,
    { outputText: "single", expanded: false, previewLines: 5 },
    theme,
  );
  assert.doesNotMatch(
    (compact as any).children[0].render(80).join("\n"),
    /earlier/,
  );

  const empty = new render.ExpandableTextResultComponent();
  render.rebuildExpandableTextResultComponent(
    empty,
    { outputText: "", expanded: false },
    theme,
  );
  assert.deepEqual((empty as any).children, []);
});

test("text result rendering handles partial, preview, empty, and warning output", () => {
  assert.equal(
    render.renderTextToolResult(
      { content: [{ type: "text", text: "ignored" }] },
      { expanded: false, isPartial: true },
      theme,
      false,
      { partialText: "loading" },
    ),
    "<warning>loading</warning>",
  );
  const preview = render.renderTextToolResult(
    { content: [{ type: "text", text: "one\ntwo\nthree" }] },
    { expanded: false },
    theme,
    false,
    {
      previewLines: 1,
      extraMutedLines: ["", "more metadata"],
      truncation: byteTruncation as any,
    },
  );
  assert.match(preview, /1 more lines|2 more lines/);
  assert.match(preview, /more metadata/);
  assert.match(preview, /1\.0KB limit/);

  const expanded = render.renderTextToolResult(
    {
      content: [{ type: "text", text: "one\ntwo" }],
      details: { truncation: lineTruncation as any },
    },
    { expanded: true },
    theme,
    false,
  );
  assert.match(expanded, /one/);
  assert.doesNotMatch(expanded, /more lines/);
  assert.match(expanded, /Truncated/);

  assert.equal(
    render.renderTextToolResult(
      { content: [], details: { emptyMessage: "Nothing owned." } },
      { expanded: false, isPartial: true },
      theme,
      false,
    ),
    "\n<muted>Nothing owned.</muted>",
  );
  assert.equal(
    render.renderTextToolResult(
      { content: [] },
      { expanded: false },
      theme,
      false,
      { emptyMessage: "No result." },
    ),
    "\n<muted>No result.</muted>",
  );
  assert.equal(
    render.renderTextToolResult(
      { content: [] },
      { expanded: false },
      theme,
      false,
    ),
    "",
  );
});
