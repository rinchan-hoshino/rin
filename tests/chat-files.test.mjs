import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputParts, outputFiles } from '../src/chat/files.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rin-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'allowed');
  mkdirSync(root);
  const file = name => { const path = join(root, name); writeFileSync(path, 'fixture'); return path; };
  return { dir, root, file };
}

test('native image and artifact links preserve text/media order without duplicate link text', t => {
  const { root, file } = fixture(t);
  const png = file('diagram (1).png');
  const pdf = file('report.pdf');
  const input = `第一段\n![图](<${png}>)\n第二段 [报告](${pdf}) 最后`;
  const parts = outputParts(input, [root]);
  assert.deepEqual(parts.map(part => part.text ?? part.files[0].name), ['第一段\n', 'diagram (1).png', '\n第二段 ', 'report.pdf', ' 最后']);
  assert.equal(parts[1].files[0].mimeType, 'image/png');
  assert.deepEqual(outputFiles(input + ` [again](${pdf})`, [root]).map(f => f.name), ['diagram (1).png', 'report.pdf']);
});

test('code examples stay text across fences, indentation, inline, lists and blockquotes', t => {
  const { root, file } = fixture(t);
  const png = file('image.png');
  const link = `![图](${png})`;
  for (const input of [
    `\`\`\`md\n${link}\n\`\`\``, `    ${link}\n`, `引用 \`${link}\` 结束`,
    `- 示例 \`${link}\``, `> \`${link}\``, `| 示例 |\n| --- |\n| \`${link}\` |`,
    `~~~md\n${link}\n~~~`,
  ]) {
    assert.deepEqual(outputFiles(input, [root]), [], input);
    assert.deepEqual(outputParts(input, [root]), [{ text: input }]);
  }
  assert.deepEqual(outputFiles(`\`${link}\`\n\n${link}`, [root]).map(f => f.name), ['image.png']);
});

test('file roots reject symlink escapes, sibling paths, directories and oversize files', t => {
  const { root, dir, file } = fixture(t);
  const outside = join(dir, 'outside.png'); writeFileSync(outside, 'private');
  const escaped = join(root, 'escaped.png'); symlinkSync(outside, escaped);
  const big = file('big.bin'); truncateSync(big, 20 * 1024 * 1024 + 1);
  for (const path of [outside, escaped, big, root]) {
    const input = `[附件](${path})`;
    assert.deepEqual(outputParts(input, [root]), [{text:input}]);
  }
  const dotName = file('..allowed.png');
  assert.equal(outputFiles(`[图](${dotName})`, [root]).length, 1);
});

test('native Markdown supports encoded paths, balanced parentheses and media MIME', t => {
  const {root, file} = fixture(t);
  for (const [name,mime] of [['a b.gif','image/gif'],['a(1).ogg','audio/ogg'],['a.wav','audio/wav'],['a.webm','video/webm']]) {
    const path = file(name);
    assert.equal(outputFiles(`![媒体](${encodeURI(path)} "标题")`, [root])[0]?.mimeType, mime);
  }
  const input = '远程 ![图](https://example.test/a.png) 和 [文件](relative.pdf)';
  assert.deepEqual(outputParts(input, [root]), [{text:input}]);
});
