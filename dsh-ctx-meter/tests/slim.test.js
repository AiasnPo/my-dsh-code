'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clip,
  planSlim,
  encodeSessionText,
  verifyRewrite,
  slimSession,
  appendSlimLog,
  renderSlim,
} = require('../src/slim');
const { decodeSessionFile, parseRecords, ZSTD_MAGIC } = require('../src/store');

const DAY = 86400000;

// 用伪随机字符而不是重复字符：zstd 会把 "xxxx…" 压到几十字节，
// 那样「压缩后体积是否变小」测的就是熵而不是裁剪效果。
const BIG = (() => {
  let seed = 42;
  let out = '';
  while (out.length < 20000) {
    // Math.imul 才是 32 位乘法；直接用 * 会因双精度丢位而产生周期性文本，
    // 那样 zstd 能把它压到几百字节，"体积变小"就不是裁剪的功劳了。
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(33 + ((seed >>> 16) % 90));
  }
  return out;
})();

/** 真实读盘：给 slimSession 的 load 回调。 */
function loadFile(ref) {
  const decoded = decodeSessionFile(ref.file);
  const parsed = parseRecords(decoded.bytes);
  return { records: parsed.records, badLines: parsed.badLines };
}

function records() {
  return [
    { seq: 0, type: 'request/header', data: { tools: ['read'] } },
    { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '帮我看下这个大文件' }] } } },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: BIG },
            { type: 'text', text: '先读文件再分析。' },
          ],
        },
      },
    },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'text', text: BIG }] } } },
  ];
}

function writeSession(dir, recs, frameBytes) {
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const text = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, encodeSessionText(text, frameBytes));
  return file;
}

test('clip 保留头尾、中间留省略说明', () => {
  const out = clip('a'.repeat(100), 10, 5);
  assert.ok(out.startsWith('a'.repeat(10)));
  assert.ok(out.endsWith('a'.repeat(5)));
  assert.match(out, /省略 85 字符/);
  assert.ok(out.length < 100 + 40);
});

test('planSlim 只裁 tool/result 与 reasoning，用户与正式回复不动', () => {
  const recs = records();
  const plan = planSlim(recs);
  assert.equal(plan.hits.length, 2);
  assert.deepEqual(plan.hits.map((h) => h.kind).sort(), ['reasoning', 'tool/result']);
  assert.ok(plan.after < plan.before);
  assert.equal(plan.records[1].data.message.content[0].text, '帮我看下这个大文件');
  assert.equal(plan.records[2].data.message.content[1].text, '先读文件再分析。');
  assert.equal(plan.byKind.reasoning.count, 1);
  assert.equal(plan.byKind['tool/result'].count, 1);
});

test('planSlim 不动原数组，且门槛调高后就无块可裁', () => {
  const recs = records();
  const before = JSON.stringify(recs);
  planSlim(recs);
  assert.equal(JSON.stringify(recs), before);

  const relaxed = planSlim(recs, { maxToolChars: 1e9, maxReasoningChars: 1e9 });
  assert.equal(relaxed.hits.length, 0);
  assert.equal(relaxed.before, relaxed.after);
});

test('encodeSessionText 写出的多帧 zstd 能逐帧解回同样的文本', () => {
  // 用不可压缩的文本，否则 zstd 会把 8000 个 'y' 压成几十字节，
  // 「输出大于一帧」这种体积断言就没意义了；帧数由 decodeSessionFile 直接报。
  const text = Array.from({ length: 10 }, (_, i) => `line ${i} ${BIG.slice(i * 1000, (i + 1) * 1000)}`).join('\n') + '\n';
  const buf = encodeSessionText(text, 1024);
  assert.ok(buf.subarray(0, 4).equals(ZSTD_MAGIC));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-slim-enc-'));
  try {
    const file = path.join(dir, 'f.zstd');
    fs.writeFileSync(file, buf);
    const decoded = decodeSessionFile(file);
    assert.ok(decoded.frames > 1);
    assert.equal(decoded.skipped, 0);
    assert.equal(decoded.bytes.toString('utf8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRewrite 校验记录数与 seq：少一条就判失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-slim-verify-'));
  try {
    const recs = records();
    const good = writeSession(dir, recs);
    assert.equal(verifyRewrite(good, recs).ok, true);

    const fewer = path.join(dir, 'fewer.zstd');
    fs.writeFileSync(fewer, encodeSessionText(recs.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n'));
    const bad = verifyRewrite(fewer, recs);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /记录数变了/);

    const garbage = path.join(dir, 'garbage.zstd');
    fs.writeFileSync(garbage, 'not zstd');
    assert.equal(verifyRewrite(garbage, recs).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slimSession 真删：文件变小、备份留存、记录数与 seq 不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-slim-run-'));
  try {
    const recs = records();
    const file = writeSession(dir, recs);
    const before = fs.statSync(file).size;
    const ref = {
      id: 's1',
      workspace: 'ws',
      file,
      size: before,
      mtimeMs: Date.now() - 30 * DAY,
      internal: false,
    };

    const res = slimSession({ ref, loaded: { records: parseRecords(decodeSessionFile(file).bytes).records, badLines: 0 } });
    assert.equal(res.slimmed, true);
    assert.ok(res.sizeAfter < before, `体积未降：${before} → ${res.sizeAfter}`);
    assert.ok(res.charsAfter < res.charsBefore);
    assert.equal(res.hits, 2);
    assert.equal(fs.existsSync(`${file}.bak`), true);
    assert.equal(fs.existsSync(`${file}.slim.tmp`), false);

    const reread = parseRecords(decodeSessionFile(file).bytes);
    assert.equal(reread.badLines, 0);
    assert.deepEqual(reread.records.map((r) => r.seq), recs.map((r) => r.seq));
    assert.deepEqual(reread.records.map((r) => r.type), recs.map((r) => r.type));
    assert.ok(reread.records[3].data.message.content[0].text.length < BIG.length);
    assert.equal(reread.records[1].data.message.content[0].text, '帮我看下这个大文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slimSession 对太活跃的会话与 dry-run 都不写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-slim-skip-'));
  try {
    const recs = records();
    const file = writeSession(dir, recs);
    const original = fs.readFileSync(file);

    const active = slimSession({
      ref: { id: 'a', workspace: 'ws', file, size: original.length, mtimeMs: Date.now(), internal: false },
      load: loadFile,
    });
    assert.equal(active.slimmed, false);
    assert.equal(active.reason, 'too-active');
    assert.ok(fs.readFileSync(file).equals(original));

    const dry = slimSession({
      ref: { id: 'b', workspace: 'ws', file, size: original.length, mtimeMs: Date.now() - 30 * DAY, internal: false },
      load: loadFile,
      opts: { dryRun: true },
    });
    assert.equal(dry.slimmed, false);
    assert.equal(dry.reason, 'dry-run');
    assert.equal(dry.hits, 2);
    assert.ok(fs.readFileSync(file).equals(original));
    assert.equal(fs.existsSync(`${file}.bak`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendSlimLog 只记动过的会话，renderSlim 汇总展示', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-slim-log-'));
  try {
    const recs = records();
    const file = writeSession(dir, recs);
    const ref = { id: 's1', workspace: 'ws', file, size: fs.statSync(file).size, mtimeMs: Date.now() - 30 * DAY, internal: false };
    const res = slimSession({ ref, load: loadFile });
    const logPath = appendSlimLog(dir, [res, { id: 'skip', slimmed: false, reason: 'too-active' }]);
    assert.ok(logPath);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, 's1');

    const out = renderSlim({ results: [res], summary: { scanned: 1, slimmed: 1, charsSaved: res.charsBefore - res.charsAfter, bytesSaved: res.savedBytes, wouldSave: 0, skipped: 0 } });
    assert.match(out, /会话瘦身/);
    assert.match(out, /已瘦身/);
    assert.match(out, /完成：1 个会话瘦身/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
