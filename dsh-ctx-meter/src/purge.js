'use strict';

/**
 * 删除（--purge）：先归档、再删掉会话目录。
 *
 * 顺序不可颠倒——只有确认归档落盘成功（index.json 有条目、raw/ 文件存在、
 * 该条目没有 error）的会话才会被删除；任何一步存疑就跳过。
 * 删除动作记进 <archiveDir>/purged.jsonl，随时可查「谁在什么时候被删了」。
 */

const fs = require('fs');
const path = require('path');

const { buildArchive, writeArchive } = require('./stale');

const DAY_MS = 86400000;
const SESSION_DIR_RE = /^session-[A-Za-z0-9._-]+$/;

const DEFAULT_OPTS = {
  minDays: 30,
  poolLimit: 24,
  includeInternal: false,
  dryRun: false,
  now: undefined,
};

/**
 * @typedef {object} PurgeOpts
 * @property {number} [minDays]
 * @property {number} [poolLimit]
 * @property {boolean} [includeInternal]
 * @property {boolean} [dryRun]
 * @property {number} [now]
 */

/** @param {string} dir */
function isSessionDir(dir) {
  return SESSION_DIR_RE.test(path.basename(path.resolve(dir)));
}

/**
 * 读回归档索引，返回「确实归档成功」的 id 集合。
 * @param {string} archiveDir
 */
function archivedIds(archiveDir) {
  const indexPath = path.join(path.resolve(archiveDir), 'index.json');
  const ok = new Set();
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return { ids: ok, indexPath, error: 'index.json 读不出来' };
  }
  for (const entry of index.entries || []) {
    if (entry.error) continue;
    if (!entry.raw) continue;
    const rawPath = path.join(path.resolve(archiveDir), entry.raw);
    try {
      if (fs.statSync(rawPath).size > 0) ok.add(entry.id);
    } catch {
      /* 文件不在就当没归档成功 */
    }
  }
  return { ids: ok, indexPath, error: null };
}

/**
 * 删掉一个会话目录，并顺手清理空了的工作区目录。
 * @param {string} dir
 * @returns {{removed: boolean, reason?: string, bytes?: number}}
 */
function removeSessionDir(dir) {
  const resolved = path.resolve(dir);
  if (!isSessionDir(resolved)) {
    return { removed: false, reason: 'not-a-session-dir' };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { removed: false, reason: 'missing' };
  }
  if (!stat.isDirectory()) return { removed: false, reason: 'not-a-directory' };

  let bytes = 0;
  try {
    for (const name of fs.readdirSync(resolved)) {
      const p = path.join(resolved, name);
      const s = fs.statSync(p);
      bytes += s.isDirectory() ? 0 : s.size;
      if (s.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    return { removed: false, reason: 'rm-failed', bytes, error: err.message };
  }

  // 工作区目录空了就一并删掉，否则 --list 里会留一堆空壳。
  const parent = path.dirname(resolved);
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    /* 删不掉空目录不影响结果 */
  }
  return { removed: true, bytes };
}

/**
 * @param {object} input
 * @param {Array<object>} input.sessions
 * @param {(ref: object) => any} input.load
 * @param {string} input.archiveDir
 * @param {PurgeOpts} [input]
 */
function purgeSessions(input) {
  const opts = { ...DEFAULT_OPTS, ...input };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const archiveDir = path.resolve(opts.archiveDir);

  const archive = buildArchive({
    sessions: opts.sessions || [],
    load: opts.load,
    now,
    minDays: opts.minDays,
    poolLimit: opts.poolLimit,
    includeInternal: opts.includeInternal,
  });

  const written = writeArchive(archiveDir, archive, { dryRun: opts.dryRun });
  const results = [];
  const sourceOf = new Map(archive.entries.map((e) => [e.id, e]));

  if (!opts.dryRun) {
    const check = archivedIds(archiveDir);
    if (check.error) {
      return {
        archive,
        written,
        results,
        summary: { archived: 0, purged: 0, skipped: archive.entries.length, bytes: 0 },
        error: check.error,
      };
    }
    for (const entry of archive.entries) {
      const base = {
        id: entry.id,
        workspace: entry.workspace,
        file: entry.file,
        ageDays: entry.ageDays,
        tier: entry.tier,
        bytes: entry.size || 0,
      };
      if (!check.ids.has(entry.id)) {
        results.push({ ...base, purged: false, reason: 'archive-incomplete' });
        continue;
      }
      const goal = removeSessionDir(path.dirname(entry.file));
      results.push({
        ...base,
        purged: goal.removed,
        reason: goal.removed ? undefined : goal.reason,
        error: goal.error,
        bytes: goal.bytes || base.bytes,
      });
    }
  } else {
    for (const entry of archive.entries) {
      const source = sourceOf.get(entry.id) || {};
      results.push({
        id: entry.id,
        workspace: entry.workspace,
        file: entry.file,
        ageDays: entry.ageDays,
        tier: entry.tier,
        bytes: entry.size || 0,
        purged: false,
        reason: 'dry-run',
        wouldDelete: source.file,
      });
    }
  }

  const purged = results.filter((r) => r.purged);
  const summary = {
    archived: opts.dryRun ? 0 : archive.entries.length,
    purged: purged.length,
    skipped: results.length - purged.length,
    bytes: purged.reduce((n, r) => n + (r.bytes || 0), 0),
  };

  if (!opts.dryRun && purged.length > 0) {
    appendPurgeLog(archiveDir, purged, now);
  }

  return { archive, written, results, summary, error: null };
}

/**
 * @param {string} archiveDir
 * @param {Array<object>} entries
 * @param {number} now
 */
function appendPurgeLog(archiveDir, entries, now) {
  const logPath = path.join(path.resolve(archiveDir), 'purged.jsonl');
  const lines = entries.map((e) =>
    JSON.stringify({
      id: e.id,
      workspace: e.workspace,
      source: e.file,
      bytes: e.bytes,
      ageDays: e.ageDays,
      purgedAt: new Date(now).toISOString(),
    }),
  );
  try {
    fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
  } catch {
    /* 日志写不进去不影响已完成的删除 */
  }
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 终端报告。 */
function renderPurge(result, opts = {}) {
  const width = Math.max(60, Math.min(opts.width || 78, 120));
  const { archive, results, summary, written } = result;
  const lines = [];
  lines.push('');
  lines.push(`  归档并删除 · 门槛 ${archive.minDays} 天 · ${results.length} 个候选`);
  lines.push('  ' + '-'.repeat(width - 2));

  if (result.error) {
    lines.push(`  归档索引不可用：${result.error} —— 一个都没删。`);
    lines.push('');
    return lines.join('\n');
  }
  if (results.length === 0) {
    const fresh = archive.counts ? archive.counts.fresh + archive.counts.aging + archive.counts.stale : 0;
    lines.push(`  没有超过门槛的会话（仍活跃 ${fresh} 个，保持原样）。`);
    lines.push('');
    return lines.join('\n');
  }

  const mark = (r) => {
    if (r.purged) return '已删除';
    if (r.reason === 'dry-run') return '将删除';
    if (r.reason === 'archive-incomplete') return '未归档';
    if (r.reason === 'missing') return '已不存在';
    return '跳过';
  };

  for (const r of results) {
    const id = String(r.id || '').slice(0, 12).padEnd(12);
    const age = `${r.ageDays}d`.padEnd(7);
    lines.push(`  ${id}${age}${mark(r).padEnd(10)}${formatMB(r.bytes || 0)}`);
  }

  lines.push('');
  lines.push(
    `  合计：删除 ${summary.purged} 个会话 · 释放 ${formatMB(summary.bytes)}` +
      (summary.skipped ? ` · 保留 ${summary.skipped} 个` : ''),
  );
  if (opts.dryRun) {
    lines.push(`  dry-run：未写盘、未删除（归档目标 ${written.indexPath}）`);
  } else if (summary.purged > 0) {
    lines.push(`  归档 ${written.indexPath}（原文 raw/ · 摘要 summaries/）`);
    lines.push(`  删除记录 ${path.join(written.root, 'purged.jsonl')}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_OPTS,
  purgeSessions,
  removeSessionDir,
  archivedIds,
  appendPurgeLog,
  renderPurge,
};
