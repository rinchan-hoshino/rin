import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKING_TEXT, normalizeAssistantSummaryText, editableIntermediateHeadText, composeEditableMessageText,
  updateEditableMessageSections, markdownToTelegramHtml, telegramHtmlToPlainText,
  normalizeRenderedText, splitPlainText, prepareText,
} from '../src/chat/presentation.mjs';

test('legacy progress head and three sections retain exact visible separators', () => {
  const initial = updateEditableMessageSections({ kind: 'working', textChunks: [editableIntermediateHeadText(DEFAULT_WORKING_TEXT)] });
  const content = updateEditableMessageSections({ kind: 'interim', textChunks: ['正在修改。'], persisted: initial });
  const todo = updateEditableMessageSections({ kind: 'todo', textChunks: ['- [ ] 验证'], persisted: content });
  assert.equal(composeEditableMessageText(todo), '... Working...\n\n────────\n\n正在修改。\n\n────────\n\n- [ ] 验证');
  const summary = updateEditableMessageSections({kind:'working', textChunks:[editableIntermediateHeadText('检查旧实现')], persisted:todo});
  assert.equal(composeEditableMessageText(summary), '... 检查旧实现\n\n────────\n\n正在修改。\n\n────────\n\n- [ ] 验证');
  assert.equal(editableIntermediateHeadText('... 已有前缀'), '... 已有前缀');
  assert.equal(composeEditableMessageText(updateEditableMessageSections({kind:'final', finalize:true, textChunks:['完成'], persisted:summary})), '完成');
});

test('legacy Telegram renderer protects code and formats native Markdown', () => {
  const text = '# 标题\n**粗体** *斜体* ~~删除~~\n[文档](https://example.test/?a=1&b=2)\n> 引用\n`**不加粗** <x>`\n```js\nconst x = "<a>";\n```';
  assert.equal(markdownToTelegramHtml(text), '<b>标题</b>\n<b>粗体</b> <i>斜体</i> <s>删除</s>\n<a href="https://example.test/?a=1&amp;amp;b=2">文档</a>\n<blockquote>引用</blockquote>\n<code>**不加粗** &lt;x&gt;</code>\n<pre>const x = &quot;&lt;a&gt;&quot;;\n</pre>');
  assert.equal(telegramHtmlToPlainText('<b>标题</b>\n<blockquote>引用</blockquote><code>&lt;x&gt;</code>'), '标题\n引用\n<x>');
});

test('Discord preserves Markdown while Telegram prepares HTML payloads', () => {
  assert.deepEqual(prepareText('discord', '**粗体**\n> 引用'), [{text:'**粗体**\n> 引用'}]);
  assert.deepEqual(prepareText('telegram', '**粗体**\n> 引用'), [{text:'<b>粗体</b>\n<blockquote>引用</blockquote>',parseMode:'HTML'}]);
});

test('legacy whitespace normalization and chunk policy are preserved', () => {
  assert.equal(normalizeRenderedText('\r\n  保留缩进  \r\n尾部  \n'), '  保留缩进\n尾部');
  assert.deepEqual(splitPlainText('第一段\n\n第二段\n第三段', 8), ['第一段', '第二段\n第三段']);
  assert.deepEqual(splitPlainText('😀😀😀', 2), ['😀😀','😀']);
  // The old renderer splits the HTML string itself; adapters must handle parse
  // failures. This is a compatibility observation, not HTML-aware chunking.
  assert.deepEqual(prepareText('telegram','**abcd**',5), [{text:'<b>ab',parseMode:'HTML'},{text:'cd</b',parseMode:'HTML'},{text:'>',parseMode:'HTML'}]);
});

test('legacy summary keeps only the latest paragraph and strips Markdown', () => {
  assert.equal(normalizeAssistantSummaryText('**旧摘要**\n\n  ## 最新摘要\n**检查** `代码` 与 [链接](https://example.test)  '), '最新摘要 检查 代码 与 链接');
  assert.equal(normalizeAssistantSummaryText('第一段\r\n\r\n第二段\r\n换行'), '第二段 换行');
  assert.equal(normalizeAssistantSummaryText('  '), '');
});
