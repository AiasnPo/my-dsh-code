'use strict';

/**
 * 瘦身（--slim）：就地把非活跃会话里的「大块文本」裁短，重新压回磁盘。
 *
 * 只动两类内容，且只在字面量远超阅读所需时才动：
 *   1) tool/result 里每块 text —— 文件读出的整页内容、超长命令输出；
 *   2) assistant/message 里的 reasoning —— 思考过程，不参与对话可读性。
 * 用户消息、assistant 的正式回复、压缩摘要、request/header（工具定义快照）
 * 一律不碰：它们是回看历史时真正要读的东西。
 *
 * 安全性靠三道闸：不删任何一条记录（只改 text 值）、写临时文件后重新解压
 * 校验 seq 序列与记录数、覆盖前默认留一份 .bak。任何一步不符就放弃该会话。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { ZSTD_MAGIC, decodeSessionFile, parseRecords } = require('./store');

const DAY_MS = 86400000;
const SLIM_LOG = 'slim.jsonl';

const DEFAULT_OPTS = {
  minAgeDays: 7,
  maxToolChars: 4000,
  keepToolHead: 2400,
  keepToolTail: 1200,
  maxReasoningChars: 2000,
  keepReasoningHead: 1200,
  keepReasoningTail: 400,
  slimToolCalls: false,
  maxToolCallChars: 12000,
  keepToolCallHead: 2000,
  keepToolCallTail: 300,
  backup: true,
  dryRun: false,
  frameBytes: 512 * 1024,
};

/**
 * @typedef {object} SlimHit
 * @property {string} id
 * @property {string} kind      tool/result | reasoning | tool/call
 * @property {number} seq
 * @property {number} lane      同一记录内的第几个块
 * @property {number} before
 * @property {number} after
 */

/** 截断一块文本，中间留一句说明。 */
function clip(text, head, tail) {
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…（已瘦身：省略 ${omitted} 字符）…\n${text.slice(text.length - tail)}`;
}

/**
 * 就地裁剪一条记录（会修改传入的副本）。
 * @returns {SlimHit[]}
 */
function slimRecord(rec, opts) {
  /** @type {SlimHit[]} */
  const hits = [];
  const id = rec.type;
  const seq = rec.seq;

  if (id === 'tool/result' || id === 'assistant/message') {
    const content = rec.data && rec.data.message && rec.data.message.content;
    if (Array.isArray(content)) {
      content.forEach((block, i) => {
        if (!block || typeof block.text !== 'string') return;
        if (block.type === 'text' && id === 'tool/result') {
          if (block.text.length <= opts.maxToolChars) return;
          const after = clip(block.text, opts.keepToolHead, opts.keepToolTail);
          hits.push({ id, kind: 'tool/result', seq, lane: i, before: block.text.length, after: after.length });
          block.text = after;
        } else if (block.type === 'reasoning' && id === 'assistant/message') {
          if (block.text.length <= opts.maxReasoningChars) return;
          const after = clip(block.text, opts.keepReasoningHead, opts.keepReasoningTail);
          hits.push({ id, kind: 'reasoning', seq, lane: i, before: block.text.length, after: after.length });
          block.text = after;
        }
      });
    }
  }

  if (id === 'tool/call' && opts.slimToolCalls) {
    const args = rec.data && rec.data.arguments;
    if (typeof args === 'string' && args.length > opts.maxToolCallChars) {
      const after = clip(args, opts.keepToolCallHead, opts.keepToolCallTail);
      hits.push({ id, kind: 'tool/call', seq, lane: 0, before: args.length, after: after.length });
      rec.data.arguments = after;
    }
  }

  return hits;
}

/**
 * 计算瘦身计划，不动原数组。
 * @param {Record<string, any>[]} records
 * @param {object} [opts]
 */
function planSlim(records, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const copies = records.map((r) => JSON.parse(JSON.stringify(r)));
  /** @type {SlimHit[]} */
  const hits = [];
  for (const rec of copies) hits.push(...slimRecord(rec, o));

  const before = records.reduce((n, r) => n + JSON.stringify(r).length, 0);
  const after = copies.reduce((n, r) => n + JSON.stringify(r).length, 0);
  const byKind = {};
  for (const h of hits) {
    const e = byKind[h.kind] || { count: 0, before: 0, after: 0 };
    e.count += 1;
    e.before += h.before;
    e.after += h.after;
    byKind[h.kind] = e;
  }
  return { records: copies, hits, before, after, byKind };
}

/**
 * 把文本按行切成若干块，各自压成一帧再首尾相接——与会话文件的既有格式一致，
 * 也让读取端「按魔数逐帧解」的逻辑继续成立。
 * @param {string} text
 * @param {number} [frameBytes]
 * @returns {Buffer}
 */
function encodeSessionText(text, frameBytes = DEFAULT_OPTS.frameBytes) {
  /** @type {Buffer[]} */
  const frames = [];
  let buf = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 行分隔符必须跟着行走：切帧时如果把它丢掉，拼回来的 JSONL 就会把
    // 相邻两条记录粘成一行——记录数看起来没变，内容却已经错了。
    const piece = lines[i] + (i < lines.length - 1 ? '\n' : '');
    if (buf && Buffer.byteLength(buf, 'utf8') + Buffer.byteLength(piece, 'utf8') > frameBytes) {
      frames.push(zlib.zstdCompressSync(Buffer.from(buf, 'utf8')));
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf) frames.push(zlib.zstdCompressSync(Buffer.from(buf, 'utf8')));
  const out = Buffer.concat(frames);
  if (!out.subarray(0, 4).equals(ZSTD_MAGIC)) throw new Error('encode produced no zstd frame');
  return out;
}

/**
 * 校验瘦身结果：记录数、seq 序列、每条都能重新解析。
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyRewrite(file, originalRecords) {
  let decoded;
  try {
    decoded = decodeSessionFile(file);
  } catch (err) {
    return { ok: false, reason: `重写文件解不开：${err.message}` };
  }
  const parsed = parseRecords(decoded.bytes);
  if (parsed.badLines > 0) return { ok: false, reason: `重写后有 ${parsed.badLines} 行解析失败` };
  if (parsed.records.length !== originalRecords.length) {
    return { ok: false, reason: `记录数变了 ${originalRecords.length} → ${parsed.records.length}` };
  }
  for (let i = 0; i < originalRecords.length; i += 1) {
    const a = originalRecords[i];
    const b = parsed.records[i];
    if (a.seq !== b.seq || a.type !== b.type) {
      return { ok: false, reason: `第 ${i} 条不一致（seq ${a.seq} vs ${b.seq}）` };
    }
  }
  return { ok: true };
}

/**
 * 对一个会话执行瘦身。
 * @param {object} input
 * @param {object} input.ref            SessionRef
 * @param {boolean} [input.loaded]      是否已经加载过（避免重复解码）
 * @param {(ref: object) => any} [input.load]
 * @param {object} [input.opts]
 */
function slimSession(input) {
  const opts = { ...DEFAULT_OPTS, ...input.opts };
  const ref = input.ref;
  const ageDays = (Date.now() - ref.mtimeMs) / DAY_MS;

  const base = { id: ref.id, workspace: ref.workspace, file: ref.file, size: ref.size, ageDays };
  if (ageDays < opts.minAgeDays) {
    return { ...base, slimmed: false, reason: 'too-active', ageDays };
  }

  const loaded = input.loaded || input.load(ref);
  if (loaded.badLines > 0) {
    return { ...base, slimmed: false, reason: `原文件有 ${loaded.badLines} 行解析失败，不动它` };
  }

  const plan = planSlim(loaded.records, opts);
  if (plan.hits.length === 0) {
    return { ...base, slimmed: false, reason: 'nothing-to-trim', plan };
  }

  const result = {
    ...base,
    slimmed: false,
    plan,
    charsBefore: plan.before,
    charsAfter: plan.after,
    hits: plan.hits.length,
    byKind: plan.byKind,
  };

  if (opts.dryRun) return { ...result, reason: 'dry-run' };

  const text = plan.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const compressed = encodeSessionText(text, opts.frameBytes);
  const tmp = `${ref.file}.slim.tmp`;
  try {
    fs.writeFileSync(tmp, compressed);
  } catch (err) {
    return { ...result, reason: `写临时文件失败：${err.message}` };
  }

  const check = verifyRewrite(tmp, loaded.records);
  if (!check.ok) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ...result, reason: check.reason };
  }

  let backupFile = null;
  try {
    if (opts.backup) {
      backupFile = `${ref.file}.bak`;
      if (!fs.existsSync(backupFile)) fs.copyFileSync(ref.file, backupFile);
    }
    fs.renameSync(tmp, ref.file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ...result, reason: `替换失败：${err.message}` };
  }

  const sizeAfter = compressed.length;
  return {
    ...result,
    slimmed: true,
    sizeBefore: ref.size,
    sizeAfter,
    backup: backupFile,
    savedBytes: ref.size - sizeAfter,
  };
}

/**
 * 批量瘦身，返回报告。只处理超过门槛的会话。
 * @param {object} input
 * @param {object[]} input.sessions
 * @param {(ref: object) => any} input.load
 * @param {object} [input.opts]
 */
function slimSessions(input) {
  const opts = { ...DEFAULT_OPTS, ...input.opts };
  const results = input.sessions.map((ref) => slimSession({ ref, load: input.load, opts }));
  const slimmed = results.filter((r) => r.slimmed);
  const planned = results.filter((r) => r.plan && r.plan.hits.length > 0 && !r.slimmed);
  return {
    results,
    summary: {
      scanned: results.length,
      slimmed: slimmed.length,
      charsSaved: slimmed.reduce((n, r) => n + (r.charsBefore - r.charsAfter), 0),
      bytesSaved: slimmed.reduce((n, r) => n + (r.savedBytes || 0), 0),
      wouldSave: planned.reduce((n, r) => n + (r.charsBefore - r.charsAfter), 0),
      skipped: results.filter((r) => !r.slimmed).length,
    },
  };
}

/** 瘦身记录追加到归档目录，便于以后知道哪些会话被动过。 */
function appendSlimLog(archiveDir, results, nowMs = Date.now()) {
  const lines = [];
  for (const r of results) {
    if (!r.slimmed && r.reason !== 'dry-run') continue;
    if (!r.plan || r.plan.hits.length === 0) continue;
    lines.push(
      JSON.stringify({
        id: r.id,
        workspace: r.workspace,
        source: r.file,
        slimmed: !!r.slimmed,
        hits: r.hits,
        charsBefore: r.charsBefore,
        charsAfter: r.charsAfter,
        sizeBefore: r.sizeBefore,
        sizeAfter: r.sizeAfter,
        backup: r.backup || null,
        at: new Date(nowMs).toISOString(),
      }),
    );
  }
  if (lines.length === 0) return null;
  const logPath = path.join(path.resolve(archiveDir), SLIM_LOG);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    return logPath;
  } catch {
    return null;
  }
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** 终端报告。 */
function renderSlim(report, opts = {}) {
  const width = Math.max(60, Math.min(opts.width || 78, 120));
  const lines = [];
  const s = report.summary;
  lines.push('');
  lines.push(`  会话瘦身 · 门槛 ${opts.minAgeDays ?? DEFAULT_OPTS.minAgeDays} 天 · 扫了 ${s.scanned} 个`);
  lines.push('  ' + '-'.repeat(width - 2));

  const touched = report.results.filter((r) => r.plan && r.plan.hits.length > 0);
  if (touched.length === 0) {
    lines.push('  没有需要瘦身的会话（都是小文件，或都还活跃）。');
    lines.push('');
    return lines.join('\n');
  }

  const pad = (v, n) => String(v).padEnd(n);
  lines.push(`  ${pad('会话 id', 14)}${pad('裁块', 7)}${pad('字符', 18)}${pad('体积', 18)}状态`);
  for (const r of touched) {
    const id = String(r.id).slice(0, 12).padEnd(12);
    const cnt = String(r.plan.hits.length).padEnd(6);
    const chars = `${r.charsBefore}→${r.charsAfter}`.padEnd(16);
    const size =
      r.slimmed || r.reason === 'dry-run'
        ? `${formatMB(r.sizeBefore || r.size)}→${formatMB(r.sizeAfter || r.size)}`.padEnd(16)
        : `${formatMB(r.size)}`.padEnd(16);
    const state = r.slimmed ? '已瘦身' : r.reason === 'dry-run' ? '预览' : r.reason;
    lines.push(`  ${id}${cnt}${chars}${size}${state}`);
  }

  for (const [kind, e] of Object.entries(touched.reduce((a, r) => {
    for (const [k, v] of Object.entries(r.plan.byKind)) {
      const acc = a[k] || { count: 0, before: 0, after: 0 };
      acc.count += v.count;
      acc.before += v.before;
      acc.after += v.after;
      a[k] = acc;
    }
    return a;
  }, {}))) {
    lines.push(`  · ${kind}：${e.count} 块，${e.before} → ${e.after} 字符`);
  }

  lines.push('');
  if (opts.dryRun) {
    lines.push(`  预览：可省 ${s.wouldSave} 字符（未写盘）。去掉 --dry-run 才真删。`);
  } else {
    lines.push(`  完成：${s.slimmed} 个会话瘦身，正文省 ${s.charsSaved} 字符，磁盘省 ${formatMB(s.bytesSaved)}`);
    if (s.skipped) lines.push(`  跳过 ${s.skipped} 个（太活跃 / 无可裁块 / 校验未过，原因见上表）`);
  }
  lines.push('  原始备份为同目录 *.bak，确认无问题后可自行删除。');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_OPTS,
  SLIM_LOG,
  clip,
  planSlim,
  encodeSessionText,
  verifyRewrite,
  slimSession,
  slimSessions,
  appendSlimLog,
  renderSlim,
};
