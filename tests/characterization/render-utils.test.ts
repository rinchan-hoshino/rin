import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const renderUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "pi", "render-utils.js"))
    .href
);

test("render utils format shared truncation warnings and notices", () => {
  const lineTruncation = {
    truncated: true,
    truncatedBy: "lines",
    outputLines: 10,
    totalLines: 25,
    maxLines: 10,
  };
  const byteTruncation = {
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 3,
    totalLines: 8,
    maxBytes: 1024,
  };
  const firstLineTruncation = {
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 0,
    totalLines: 1,
    maxBytes: 2048,
    firstLineExceedsLimit: true,
  };

  assert.equal(
    renderUtils.formatTruncationWarningMessage(lineTruncation),
    "Truncated: showing 10 of 25 lines (10 line limit)",
  );
  assert.equal(
    renderUtils.formatTruncationWarningMessage(byteTruncation),
    "Truncated: 3 lines shown (1.0KB limit)",
  );
  assert.equal(
    renderUtils.formatTruncationWarningMessage(firstLineTruncation),
    "First line exceeds 2.0KB limit",
  );

  assert.equal(
    renderUtils.formatTruncationNotice(lineTruncation),
    "[Showing 10 of 25 lines.]",
  );
  assert.equal(
    renderUtils.formatTruncationNotice(byteTruncation),
    "[Showing 3 of 8 lines (1.0KB limit).]",
  );
  assert.equal(
    renderUtils.formatTruncationNotice(firstLineTruncation),
    "[First line exceeds 2.0KB limit.]",
  );
  assert.equal(
    renderUtils.appendTruncationNotice("hello", lineTruncation),
    "hello\n\n[Showing 10 of 25 lines.]",
  );
});

test("render utils format shared tool durations", () => {
  assert.equal(renderUtils.formatToolDuration(undefined, undefined), undefined);
  assert.equal(renderUtils.formatToolDuration(1000, 3500), "Took 2.5s");
});

test("render utils format shared hidden result notices", () => {
  assert.equal(
    renderUtils.formatHiddenResultsNotice(5, 2),
    "[Showing top 3 of 5 results.]",
  );
  assert.equal(renderUtils.formatHiddenResultsNotice(5, 0), "");
});

test("render utils style structured tool output lines", () => {
  const theme = {
    fg: (kind, text) => `<${kind}>${text}</${kind}>`,
    bold: (text) => `**${text}**`,
  };

  assert.equal(
    renderUtils.styleToolOutputLine("path=/tmp/demo.txt", theme),
    "<muted>path</muted><dim>=</dim><accent>/tmp/demo.txt</accent>",
  );
  assert.equal(
    renderUtils.styleToolOutputLine("1. Example Result | 2026-04-17", theme),
    "<muted>1. </muted><toolTitle>**Example Result**</toolTitle><muted> | 2026-04-17</muted>",
  );
  assert.equal(
    renderUtils.styleToolOutputLine("Saved task: nightly cleanup", theme),
    "<toolTitle>**Saved task:**</toolTitle> <toolOutput>nightly cleanup</toolOutput>",
  );
});

test("render utils format tool call headers with single-word titles", () => {
  const theme = {
    fg: (kind, text) => `<${kind}>${text}</${kind}>`,
    bold: (text) => `**${text}**`,
  };

  assert.equal(
    renderUtils.formatToolCallLine("browse", "site:example.com docs", theme),
    "<toolTitle>**browse**</toolTitle> <accent>site:example.com docs</accent>",
  );
  assert.equal(
    renderUtils.formatToolCallLine("recall", "recent", theme, {
      detailStyle: "muted",
    }),
    "<toolTitle>**recall**</toolTitle> <muted>recent</muted>",
  );
  assert.equal(
    renderUtils.formatToolCallLine("bash", "npm test", theme),
    "<toolTitle>**$**</toolTitle> <accent>npm test</accent>",
  );
});

test("render utils render shared text tool previews", () => {
  const theme = {
    fg: (kind, text) => `<${kind}>${text}</${kind}>`,
  };
  const truncation = {
    truncated: true,
    truncatedBy: "lines",
    outputLines: 2,
    totalLines: 4,
    maxLines: 2,
  };

  assert.equal(
    renderUtils.renderTextToolResult(
      {
        content: [{ type: "text", text: "alpha\tbeta\n\n" }],
        details: {
          emptyMessage: "Nothing here.",
        },
      },
      { expanded: false },
      theme,
      false,
      {
        extraMutedLines: [renderUtils.formatHiddenResultsNotice(5, 2)],
        truncation,
      },
    ),
    "\n<toolOutput>alpha   beta</toolOutput>\n<muted>[Showing top 3 of 5 results.]</muted>\n<warning>[Truncated: showing 2 of 4 lines (2 line limit)]</warning>",
  );

  assert.equal(
    renderUtils.renderTextToolResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          emptyMessage: "Nothing here.",
        },
      },
      { expanded: false },
      theme,
      false,
    ),
    "\n<muted>Nothing here.</muted>",
  );

  assert.equal(
    renderUtils.renderTextToolResult(
      { content: [{ type: "text", text: "" }] },
      { expanded: true },
      theme,
      false,
      { emptyMessage: "No results." },
    ),
    "\n<muted>No results.</muted>",
  );

  assert.equal(
    renderUtils.renderTextToolResult(
      { content: [{ type: "text", text: "ignored" }] },
      { expanded: false, isPartial: true },
      theme,
      false,
      { partialText: "Fetching..." },
    ),
    "<warning>Fetching...</warning>",
  );
});

test("render utils render expanded tool warnings", () => {
  const theme = {
    fg: (kind, text) => `<${kind}>${text}</${kind}>`,
    bold: (text) => `**${text}**`,
  };

  const rendered = renderUtils.renderTextToolResult(
    {
      content: [{ type: "text", text: "browse 2\npath=/tmp/demo.txt" }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 2,
          totalLines: 8,
          maxLines: 2,
        },
      },
    },
    { expanded: true },
    theme,
    false,
  );

  assert.match(
    rendered,
    /<toolTitle>\*\*browse\*\*<\/toolTitle> <success>2<\/success>/,
  );
  assert.match(
    rendered,
    /<warning>\[Truncated: showing 2 of 8 lines \(2 line limit\)\]<\/warning>/,
  );
});

test("render utils normalize shared user-facing text fallbacks", () => {
  assert.equal(renderUtils.NO_OUTPUT_TEXT, "(no output)");
  assert.equal(
    renderUtils.getToolResultText(
      { content: [{ type: "text", text: "agent text" }] },
      false,
    ),
    "agent text",
  );
  assert.equal(
    renderUtils.getToolResultUserText(
      { content: [{ type: "text", text: "agent text" }] },
      false,
      "user text",
    ),
    "user text",
  );
  assert.equal(
    renderUtils.getToolResultUserText(
      { content: [{ type: "text", text: "agent text" }] },
      false,
      "",
    ),
    "agent text",
  );
  assert.equal(
    renderUtils.getToolResultUserText({ content: [] }, false, undefined),
    "(no output)",
  );
  assert.deepEqual(
    renderUtils.buildUserFacingTextResult(
      { content: [{ type: "text", text: "agent text" }] },
      false,
      {
        userText: "",
        details: { hiddenCount: 2 },
      },
    ),
    {
      content: [{ type: "text", text: "agent text" }],
      details: { hiddenCount: 2 },
    },
  );
});

test("render utils sanitize shared text output blocks in order", () => {
  assert.equal(
    renderUtils.getTextOutput(
      {
        content: [
          { type: "text", text: "alpha\u0000\u001b[31mred\u001b[39m" },
          { type: "other", text: "ignored" },
          { type: "text", text: "beta\r\ngamma" },
        ],
      },
      false,
    ),
    "alphared\nbeta\ngamma",
  );
});

test("render utils user text fallback ignores non-string overrides", () => {
  assert.equal(
    renderUtils.getToolResultUserText(
      { content: [{ type: "text", text: "agent text" }] },
      false,
      { text: "ignored" },
    ),
    "agent text",
  );
});

test("prepareTruncatedText leaves short text unchanged", () => {
  const result = renderUtils.prepareTruncatedText("hello world");
  assert.equal(result.outputText, "hello world");
  assert.equal(result.previewText, "hello world");
  assert.equal(result.truncation, undefined);
});

test("prepareTruncatedText appends a truncation notice when limits are exceeded", () => {
  const result = renderUtils.prepareTruncatedText("one\ntwo\nthree", {
    maxLines: 2,
  });
  assert.ok(result.truncation);
  assert.match(result.outputText, /\[Showing \d+ of \d+ lines/);
  assert.ok(result.outputText.startsWith(result.previewText));
});

test("prepareTruncatedAgentUserText reuses one truncation result for identical text", () => {
  const result = renderUtils.prepareTruncatedAgentUserText(
    "one\ntwo\nthree",
    "one\ntwo\nthree",
    { maxLines: 2 },
  );
  assert.equal(result.userPreviewText, result.previewText);
  assert.equal(result.userTruncation, result.truncation);
  assert.match(result.outputText, /\[Showing \d+ of \d+ lines/);
});
