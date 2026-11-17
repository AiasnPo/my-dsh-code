'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  purgeSessions,
  removeSessionDir,
  archivedIds,
  renderPurge,
} = require('../src/purge');

const DAY = 86400000;
const RECORDS = [
  { seq: 0, type: 'user/message', time: '2026-01-01T00:00:00.000Z', data: { text: '帮我看一下这个会话' } },
  { seq: 1, type: 'assistant/message', time: '2026-01-01T00:00:01.000Z', data: { text: '好的，先读文件。' } },
];

/** 造一棵真实的 <root>/<ws>/session-<id>/session.v4.jsonl.zstd 目录树。 */
function makeTree(ids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-purge-'));
  const ws = path.join(root, '--ws--');
  const sessions = [];
  for (const id of ids) {
    const dir = path.join(ws, `session-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, 'placeholder');
    sessions.push({ id, workspace: 'ws', file, size: 11, mtimeMs: 0, internal: false });
  }
  const archiveDir = path.join(root, 'archive');
  return { root, ws, archiveDir, sessions };
}

function aged(sessions, days) {
  const now = Date.parse('2026-11-16T00:00:00.000Z');
  return sessions.map((s) => ({ ...s, mtimeMs: now - days * DAY }));
}

const load = () => ({ records: RECORDS, badLines: 0 });

test('removeSessionDir 只认 session-* 目录，别的一律不动', () => {
  const { root, ws } = makeTree(['aaa']);
  const foreign = path.join(ws, 'not-a-session');
  fs.mkdirSync(foreign, { recursive: true });
  try {
    assert.deepEqual(removeSessionDir(ws).reason, 'not-a-session-dir');
    assert.deepEqual(removeSessionDir(foreign).reason, 'not-a-session-dir');
    assert.equal(fs.existsSync(ws), true);

    const inside = path.join(ws, 'session-aaa');
    const res = removeSessionDir(inside);
    assert.equal(res.removed, true);
    assert.ok(res.bytes > 0);
    assert.equal(fs.existsSync(inside), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archivedIds 只认「索引有条目 + raw 文件非空」，缺一样都不算归档成功', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-archive-check-'));
  try {
    fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'raw', 'good.txt'), 'ok');
    fs.writeFileSync(path.join(root, 'raw', 'empty.txt'), '');
    fs.writeFileSync(
      path.join(root, 'index.json'),
      JSON.stringify({
        entries: [
          { id: 'good', raw: 'raw/good.txt' },
          { id: 'empty', raw: 'raw/empty.txt' },
          { id: 'missing', raw: 'raw/missing.txt' },
          { id: 'broken', raw: 'raw/good.txt', error: 'boom' },
        ],
      }),
    );
    const check = archivedIds(root);
    assert.equal(check.error, null);
    assert.deepEqual([...check.ids].sort(), ['good']);
    assert.equal(archivedIds(path.join(root, 'nope')).error, 'index.json 读不出来');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run 只出计划：一个都不删，也不写归档', () => {
  const { root, archiveDir, sessions } = makeTree(['old1']);
  try {
    const refs = aged(sessions, 60);
    const res = purgeSessions({ sessions: refs, load, archiveDir, minDays: 30, dryRun: true, now: refs[0].mtimeMs + 60 * DAY });
    assert.equal(res.error, null);
    assert.equal(res.summary.purged, 0);
    assert.equal(res.summary.archived, 0);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].reason, 'dry-run');
    assert.ok(res.results[0].wouldDelete);
    assert.equal(fs.existsSync(refs[0].file), true);
    assert.equal(fs.existsSync(path.join(archiveDir, 'index.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('正式执行：超龄会话先归档再删除，未超龄的原样保留', () => {
  const { root, ws, archiveDir, sessions } = makeTree(['old1', 'fresh1']);
  try {
    const refs = sessions.map((s) => ({
      ...s,
      mtimeMs: s.id === 'old1' ? Date.parse('2026-11-16T00:00:00.000Z') - 60 * DAY : Date.parse('2026-11-16T00:00:00.000Z'),
    }));
    const res = purgeSessions({ sessions: refs, load, archiveDir, minDays: 30, now: Date.parse('2026-11-16T00:00:00.000Z') });

    assert.equal(res.error, null);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].id, 'old1');
    assert.equal(res.results[0].purged, true);
    assert.equal(res.summary.purged, 1);
    assert.equal(res.summary.skipped, 0);
    assert.ok(res.summary.bytes > 0);

    assert.equal(fs.existsSync(path.join(ws, 'session-old1')), false, '超龄会话目录应被删掉');
    assert.equal(fs.existsSync(path.join(ws, 'session-fresh1', 'session.v4.jsonl.zstd')), true, '新会话不能被删');
    assert.equal(fs.existsSync(path.join(archiveDir, 'raw', 'old1.txt')), true, '归档原文要落盘');
    assert.equal(fs.existsSync(path.join(archiveDir, 'index.json')), true);

    const log = fs.readFileSync(path.join(archiveDir, 'purged.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    const line = JSON.parse(log[0]);
    assert.equal(line.id, 'old1');
    assert.equal(line.purgedAt, '2026-11-16T00:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有候选时 renderPurge 说明「保持原样」', () => {
  const { root, archiveDir, sessions } = makeTree(['fresh1']);
  try {
    const now = Date.parse('2026-11-16T00:00:00.000Z');
    const refs = aged(sessions, 1);
    const res = purgeSessions({ sessions: refs, load, archiveDir, minDays: 30, now });
    const out = renderPurge(res, { width: 80 });
    assert.match(out, /没有超过门槛的会话/);
    assert.match(out, /保持原样/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderPurge 把删除结果、体积、归档路径都写出来', () => {
  const { root, archiveDir, sessions } = makeTree(['old1']);
  try {
    const now = Date.parse('2026-11-16T00:00:00.000Z');
    const refs = aged(sessions, 60);
    const res = purgeSessions({ sessions: refs, load, archiveDir, minDays: 30, now });
    const out = renderPurge(res);
    assert.match(out, /归档并删除/);
    assert.match(out, /已删除/);
    assert.match(out, /合计：删除 1 个会话/);
    assert.match(out, /index\.json/);
    assert.match(out, /purged\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
