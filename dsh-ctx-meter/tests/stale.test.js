'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TIERS,
  tierOf,
  extractSignals,
  detectReferences,
  summarizeText,
  dialogText,
  buildArchive,
  writeArchive,
  renderArchive,
} = require('../src/stale');

const NOW = Date.parse('2026-11-16T00:00:00.000Z');
const DAY = 86400000;

const LONG = Array.from(
  { length: 12 },
  (_, i) => `第 ${i + 1} 段：上下文压缩只改变请求视图，不会删除磁盘上的原始会话记录，原文依旧可以逐条读回。`,
).join('');

function ref(id, days) {
  return { id, workspace: 'ws', file: `C:\\ws\\session-${id}\\session.v4.jsonl.zstd`, size: 1000, mtimeMs: NOW - days * DAY, internal: false };
}

function recordsOf(...texts) {
  return texts.map((text, i) => ({
    seq: i,
    type: 'user/message',
    time: new Date(NOW - DAY).toISOString(),
    data: { text },
  }));
}

const P = 'D:\\dev\\dsh-ctx-meter\\src\\store.js';

test('tierOf 按天数分档：30 / 90 / 180 三个门槛', () => {
  assert.equal(tierOf(10).key, 'fresh');
  assert.equal(tierOf(29.9).key, 'fresh');
  assert.equal(tierOf(30).key, 'aging');
  assert.equal(tierOf(89).key, 'aging');
  assert.equal(tierOf(90).key, 'stale');
  assert.equal(tierOf(179).key, 'stale');
  assert.equal(tierOf(180).key, 'dormant');
  assert.equal(tierOf(900).key, 'dormant');
});

test('摘要：预算越小越短，且不超过预算', () => {
  const short = summarizeText(LONG, 45);
  const mid = summarizeText(LONG, 160);
  assert.ok(short.text.length > 0);
  assert.ok(short.text.length <= 45, `45 预算实际 ${short.text.length}`);
  assert.ok(mid.text.length <= 160, `160 预算实际 ${mid.text.length}`);
  assert.ok(short.text.length < mid.text.length);
});

test('摘要：无文本与首句保留', () => {
  assert.equal(summarizeText('', 50).text, '(无可读文本)');
  const s = summarizeText('这是一句开头。后面还有第二句。第三句也在这里。', 20);
  assert.ok(s.text.startsWith('这是一句开头。'));
});

test('关键词：路径权重最高，虚词 n-gram 被过滤', () => {
  const text = `排查 ${P} 的切片逻辑，压缩之后原文仍在。${P}`;
  const { keywords } = extractSignals(text);
  assert.ok(keywords.some((k) => k.includes('store.js') || k.includes('dsh-ctx-meter')));
  assert.ok(keywords.some((k) => k.includes('切片') || k.includes('压缩')));
  assert.ok(!keywords.includes('的是'));
});

test('引用检测：命中路径算被提到，无关对话不算', () => {
  const target = extractSignals(`排查 ${P} 的切片逻辑。${P}`);
  const hit = detectReferences(target, [{ id: 'new1', text: `继续看 ${P} 的切片。` }]);
  assert.equal(hit.referenced, true);
  assert.deepEqual(hit.by, ['new1']);

  const miss = detectReferences(target, [
    { id: 'new2', text: '今天下午要开个会，顺便买点菜回家做饭。' },
  ]);
  assert.equal(miss.referenced, false);
  assert.deepEqual(miss.by, []);
});

test('dialogText 只收对话类记录，跳过工具调用与请求头', () => {
  const records = [
    { seq: 0, type: 'request/header', data: { tools: [{ name: 'x' }] } },
    { seq: 1, type: 'user/message', data: { text: '你好' } },
    { seq: 2, type: 'tool/call', data: { name: 'read' } },
    { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: '在的' }] } },
  ];
  const dialog = dialogText(records);
  assert.equal(dialog.messages, 2);
  assert.match(dialog.text, /你好/);
  assert.match(dialog.text, /在的/);
  assert.doesNotMatch(dialog.text, /request|tool/);
});

test('buildArchive：跳过新鲜会话，越老摘要预算越小，引用后放宽', () => {
  const sessions = [ref('aaa', 25), ref('bbb', 100), ref('ccc', 300)];
  const texts = {
    aaa: [`继续看 ${P} 的切片。`, '今天先这样。'],
    bbb: ['中期档案乙，与切片无关的迁移笔记。', '记录一条中间结论。'],
    ccc: [`排查 ${P} 的切片逻辑。`, `${P} 是入口。`, '沉睡档案甲。'],
  };
  const archive = buildArchive({
    sessions,
    load: (r) => ({ records: recordsOf(...texts[r.id]) }),
    now: NOW,
  });

  const ids = archive.entries.map((e) => e.id);
  assert.deepEqual(ids, ['ccc', 'bbb']); // 老的在前，25 天的被跳过
  assert.equal(archive.counts.fresh, 1);

  const bbb = archive.entries.find((e) => e.id === 'bbb');
  const ccc = archive.entries.find((e) => e.id === 'ccc');
  assert.equal(bbb.tier, 'stale');
  assert.equal(ccc.tier, 'dormant');
  const budgetOf = (k) => TIERS.find((t) => t.key === k).budget;
  assert.ok(budgetOf('dormant') < budgetOf('stale'), '未被提及时，越老预算越小');
  assert.ok(budgetOf('stale') < budgetOf('aging'));
  assert.equal(bbb.referenced, false);
  assert.equal(ccc.referenced, true);
  assert.ok(ccc.summaryBudget > budgetOf('dormant'), '被引用应放宽预算');
  assert.ok(ccc.summary.length <= ccc.summaryBudget);
});

test('writeArchive：原文与摘要分开落盘，index 只存指针', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctx-stale-'));
  try {
    const sessions = [ref('ddd', 200)];
    const archive = buildArchive({
      sessions,
      load: () => ({ records: recordsOf(LONG, '一句补充。') }),
      now: NOW,
    });
    const out = writeArchive(dir, archive);

    assert.ok(fs.existsSync(out.indexPath));
    assert.ok(fs.existsSync(path.join(dir, 'raw', 'ddd.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'summaries', 'ddd.md')));

    const index = JSON.parse(fs.readFileSync(out.indexPath, 'utf8'));
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].raw, 'raw/ddd.txt');
    assert.equal(index.entries[0].summary, 'summaries/ddd.md');

    const indexRaw = fs.readFileSync(out.indexPath, 'utf8');
    const rawFile = fs.readFileSync(path.join(dir, 'raw', 'ddd.txt'), 'utf8');
    const summaryFile = fs.readFileSync(path.join(dir, 'summaries', 'ddd.md'), 'utf8');

    assert.match(rawFile, /会话原文导出/);
    assert.ok(rawFile.includes('第 12 段'), '原文应完整');
    assert.match(summaryFile, /## 摘要/);
    assert.doesNotMatch(summaryFile, /第 12 段/, '摘要不应抄原文');
    assert.doesNotMatch(indexRaw, /第 12 段/, 'index 不应夹带原文');
    assert.ok(indexRaw.length < rawFile.length, 'index 应比原文小（只存指针与关键词）');
    assert.ok(index.entries[0].rawHash.length === 16);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderArchive 输出表格，空归档也能渲染', () => {
  const archive = buildArchive({ sessions: [ref('eee', 10)], load: () => ({ records: [] }), now: NOW });
  const text = renderArchive(archive);
  assert.match(text, /没有超过门槛的会话/);

  const archive2 = buildArchive({
    sessions: [ref('fff', 120)],
    load: () => ({ records: recordsOf(LONG) }),
    now: NOW,
  });
  const text2 = renderArchive(archive2);
  assert.match(text2, /fff/);
  assert.match(text2, /陈旧/);
});

test('minDays 缩放全部门槛：设 7 天则 7 / 21 / 42', () => {
  assert.equal(tierOf(6, 7).key, 'fresh');
  assert.equal(tierOf(7, 7).key, 'aging');
  assert.equal(tierOf(21, 7).key, 'stale');
  assert.equal(tierOf(42, 7).key, 'dormant');

  const archive = buildArchive({
    sessions: [ref('ggg', 40), ref('hhh', 5)],
    load: () => ({ records: recordsOf(LONG) }),
    now: NOW,
    minDays: 7,
  });
  assert.deepEqual(archive.entries.map((e) => e.id), ['ggg']);
  assert.equal(archive.minDays, 7);
});

test('摘要不吃系统样板句：跳过 You are / 工具清单，保留真实一句', () => {
  const text = [
    'You are an AI assistant running inside DeepSeek Harness. You have access to a set of tools.',
    '## Available tools',
    'memory_log — 追加日志。',
    '我们需要先确认切片逻辑是否保留了原文。',
  ].join('\n');
  const s = summarizeText(text, 60);
  assert.ok(!/You are/.test(s.text), `不该抄样板：${s.text}`);
  assert.match(s.text, /切片逻辑/);
});

test('摘要短预算下仍出首句，不返回只剩省略号', () => {
  const s = summarizeText('定位问题：zstd 多帧要用魔数切片再逐帧解压，否则整段读不出来。', 12);
  assert.ok(s.text.length > 0);
  assert.ok(!/^…$/.test(s.text.trim()));
});
