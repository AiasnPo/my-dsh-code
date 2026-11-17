'use strict';

/**
 * stale.js — 沉寂会话检测 + 「原文 / 摘要」分账归档。
 *
 * 目标：把一个月前、几个月前的会话找出来标注；判断它此后是否又被
 * 提到（引用检测）；对没被提到的、越老的内容给出越短的摘要。
 * 原文与摘要分开落盘：archive/raw/<id>.txt 与 archive/summaries/<id>.md，
 * index.json 只放指针与判据，不把两边混在一个文件里。
 *
 * 纯规则实现，无 AI 调用、无第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 只有这些记录类型算「对话内容」；工具定义/系统提示正文会制造虚假相似。 */
const DIALOG_TYPES = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'compaction/summary',
]);

/**
 * 时间分档：越老、越没人提，摘要预算越小。
 * minDays 从大到小匹配。
 */
// factor 是相对「归档门槛 minDays」的倍数：门槛 30 天时即 30/90/180 天，
// 这样调 --days 后档位与表格不会自相矛盾（门槛 1 天时 1.8 天是「渐远」而不是「新鲜」）。
const TIERS = [
  { key: 'dormant', label: '沉睡', factor: 6, budget: 45, retainedBudget: 110 },
  { key: 'stale', label: '陈旧', factor: 3, budget: 90, retainedBudget: 200 },
  { key: 'aging', label: '渐远', factor: 1, budget: 160, retainedBudget: 320 },
  { key: 'fresh', label: '新鲜', factor: 0, budget: 0, retainedBudget: 0 },
];

const TIER_BY_KEY = new Map(TIERS.map((t) => [t.key, t]));

const EN_STOP = new Set([
  'this', 'that', 'with', 'from', 'have', 'were', 'will', 'would', 'could', 'should',
  'there', 'their', 'about', 'which', 'these', 'those', 'then', 'than', 'them', 'they',
  'what', 'when', 'where', 'while', 'your', 'yours', 'been', 'being', 'also', 'into',
  'over', 'such', 'some', 'more', 'most', 'only', 'just', 'like', 'make', 'made',
  'then', 'because', 'before', 'after', 'still', 'even', 'much', 'many', 'very',
  'here', 'does', 'done', 'each', 'other', 'same', 'true', 'false', 'null', 'undefined',
  'function', 'return', 'const', 'require', 'module', 'exports', 'string', 'number',
  'object', 'array', 'error', 'result', 'value', 'index', 'https', 'http', 'www',
]);

/** 虚词字符：一个 n-gram 若全部由这些字组成就丢掉。 */
const ZH_STOP_CHARS = new Set(
  ('的了是吗呢啊吧哦嗯么呀嘛和与或但而并之其所以因如果就都也很更最这那你我他她它们个把被对在上中下里为以到从 　').split(''),
);

const DEFAULT_OPTS = {
  minDays: 30,
  poolLimit: 24,
  maxChars: 200000,
  signalLimit: 30,
  byLimit: 3,
  rawMaxChars: 400000,
};

/** @param {number} ageDays */
function tierOf(ageDays, baseDays = 30) {
  const base = Number(baseDays) > 0 ? Number(baseDays) : 30;
  for (const tier of TIERS) {
    if (ageDays >= tier.factor * base) return tier;
  }
  return TIER_BY_KEY.get('fresh');
}

/**
 * @param {number} mtimeMs
 * @param {number} nowMs
 */
function ageInDays(mtimeMs, nowMs) {
  const ms = Math.max(0, Number(nowMs) - Number(mtimeMs));
  return ms / 86400000;
}

/**
 * 宽容取文本：不同记录版本的 content 结构不一样，这里只认常见的键，
 * 跳过 base64 内联资源与超长单串（图片/压缩块）。
 * @param {unknown} value
 * @param {number} depth
 * @returns {string}
 */
function pickText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') {
    if (/^data:[a-z]+\//i.test(value)) return '';
    if (value.length > 20000) return value.slice(0, 20000) + '…';
    return value;
  }
  if (typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => pickText(v, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  for (const key of ['text', 'content', 'message', 'body', 'summary', 'parts']) {
    if (key in value) {
      const t = pickText(value[key], depth + 1);
      if (t) return t;
    }
  }
  return '';
}

/** @param {Record<string, any>} rec */
function recordText(rec) {
  if (!rec || !DIALOG_TYPES.has(rec.type)) return '';
  return pickText(rec.data).trim();
}

/**
 * 把记录流压成可检索的对话文本。
 * @param {Array<Record<string, any>>} records
 */
function dialogText(records) {
  const lines = [];
  let messages = 0;
  for (const rec of records || []) {
    const text = recordText(rec);
    if (!text) continue;
    messages += 1;
    const who = rec.type === 'user/message' ? '用户' : rec.type === 'assistant/message' ? '助手' : rec.type;
    lines.push({ seq: rec.seq, type: rec.type, who, time: rec.time, text });
  }
  return { lines, messages, text: lines.map((l) => l.text).join('\n') };
}

/**
 * 关键词/短语抽取：路径与文件名权重最高，其次英文词，最后中日韩 n-gram。
 * @param {string} text
 * @param {{ limit?: number }} [opts]
 */
function extractSignals(text, opts = {}) {
  const limit = opts.limit || DEFAULT_OPTS.signalLimit;
  const src = String(text || '');
  const lower = src.toLowerCase();
  const weights = new Map();

  const bump = (token, weight) => {
    if (!token || token.length < 2) return;
    weights.set(token, (weights.get(token) || 0) + weight);
  };

  for (const m of lower.matchAll(/[a-z]:\\[^\s"'`，。；）】]+/g)) bump(m[0].slice(0, 120), 8);
  for (const m of lower.matchAll(/[\w.-]{1,80}\.(?:js|cjs|mjs|ts|tsx|json|jsonl|md|py|yml|yaml|png|jpe?g|webp|zip|exe|asar|zstd|vue)\b/g)) {
    bump(m[0], 5);
  }
  for (const m of lower.matchAll(/[a-z][a-z0-9_-]{3,}/g)) {
    if (!EN_STOP.has(m[0])) bump(m[0], 1);
  }

  const runs = src.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  for (const run of runs.slice(0, 4000)) {
    for (let n = 2; n <= 5; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const gram = run.slice(i, i + n);
        let stopOnly = true;
        for (const ch of gram) {
          if (!ZH_STOP_CHARS.has(ch)) {
            stopOnly = false;
            break;
          }
        }
        if (stopOnly) continue;
        bump(gram, n >= 4 ? 2 : 1);
      }
    }
  }

  const scored = [...weights.entries()]
    .map(([token, count]) => ({
      token,
      count,
      score: count * Math.min(8, token.length) * (/[\\/]|\.\w+$/.test(token) ? 3 : 1),
    }))
    .filter((x) => x.count >= 2 || x.score >= 6)
    .sort((a, b) => b.score - a.score || b.token.length - a.token.length)
    .slice(0, limit);

  return {
    keywords: scored.map((x) => x.token),
    scored,
    chars: src.length,
  };
}

/**
 * 引用检测：旧会话的关键词在多新的对话里出现得够多，就算「后来又被提到过」。
 * @param {{ keywords: string[] }} target
 * @param {Array<{ id: string, text: string }>} pool 更新会话
 * @param {{ byLimit?: number }} [opts]
 */
function detectReferences(target, pool, opts = {}) {
  const byLimit = opts.byLimit || DEFAULT_OPTS.byLimit;
  const keywords = (target && target.keywords) || [];
  if (keywords.length === 0 || pool.length === 0) {
    return { referenced: false, hits: 0, strong: 0, by: [] };
  }

  const scored = [];
  for (const item of pool) {
    const haystack = String(item.text || '').toLowerCase();
    if (!haystack) continue;
    let hits = 0;
    let strong = 0;
    for (const kw of keywords) {
      if (!haystack.includes(kw)) continue;
      hits += 1;
      if (/[\\/]|\.\w+$/.test(kw)) strong += 1;
    }
    if (hits === 0) continue;
    scored.push({ id: item.id, hits, strong, score: hits + strong * 2 });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = scored[0];
  const referenced = Boolean(top && (top.strong >= 1 || top.hits >= 3));
  return {
    referenced,
    hits: top ? top.hits : 0,
    strong: top ? top.strong : 0,
    by: scored.slice(0, byLimit).map((s) => s.id),
  };
}

/** 系统提示 / 工具样板句：对摘要无信息量，不参与摘录。 */
function isBoilerplate(s) {
  if (/^#{1,6}\s/.test(s)) return true;
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(s)) return true;
  if (/^(You are|You're|Your task|You have access|Available tools|Tool definitions?|System prompt)\b/i.test(s)) {
    // 英文系统腔且长句 → 样板；短句（如 "You are right."）保留
    return s.length > 48 || /^You are an? \w+ (assistant|agent|AI)\b/i.test(s);
  }
  return false;
}

/** @param {string} text */
function sentencesOf(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 2);
}

/**
 * 规则摘要：首句给主题，其余按「长度合适 + 关键词密度」挑，填到预算为止。
 * @param {string} text
 * @param {number} budget 字符预算
 * @param {string[]} [keywords]
 */
function summarizeText(text, budget, keywords = []) {
  const limit = Math.max(12, Math.round(Number(budget) || 0));
  const sentences = sentencesOf(text);
  if (sentences.length === 0) {
    return { text: '(无可读文本)', picked: 0, truncated: false };
  }

  const seen = new Set();
  const unique = [];
  for (const s of sentences) {
    const key = s.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }

  const scoreOf = (s) => {
    let density = 0;
    for (const kw of keywords.slice(0, 20)) {
      if (kw.length >= 2 && s.includes(kw)) density += 1;
    }
    const lengthFit = s.length <= 140 ? 1 : Math.max(0.2, 140 / s.length);
    // 系统提示/样板前缀（"You are an AI…"、"## 工具"）对摘要没有信息量，重罚
    const boiler = isBoilerplate(s) ? -100 : 0;
    return density * 2 + lengthFit + boiler;
  };

  // 首句同样要过滤：真实数据里会话开头常常是英文系统提示
  const head = unique.find((s) => !isBoilerplate(s)) || unique[0];
  const picked = [head];
  let used = head.length;
  const rest = unique
    .filter((s) => s !== head)
    .map((s, i) => ({ s, i, score: scoreOf(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  for (const item of rest) {
    if (used + item.s.length + 1 > limit) continue;
    picked.push(item.s);
    used += item.s.length + 1;
    if (used >= limit * 0.9) break;
  }

  let out = picked.join(' ');
  let truncated = false;
  if (out.length > limit) {
    out = out.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
    truncated = true;
  }
  if (picked.length < unique.length) truncated = true;
  return { text: out, picked: picked.length, truncated };
}

/** @param {string} text */
function hashOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 构建归档索引（不写盘）。
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} input.sessions listSessions() 的结果
 * @param {(ref: any) => { records: Array<Record<string, any>> }} input.load loadSession 的薄包装
 * @param {number} [input.now]
 * @param {number} [input.minDays]
 * @param {number} [input.poolLimit]
 * @param {number} [input.maxChars]
 * @param {boolean} [input.includeInternal]
 */
function buildArchive(input) {
  const opts = { ...DEFAULT_OPTS, ...input };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const sessions = (opts.sessions || []).filter((s) => opts.includeInternal || !s.internal);

  const decorated = sessions.map((s) => {
    const ageDays = ageInDays(s.mtimeMs, now);
    return { ref: s, ageDays, tier: tierOf(ageDays, opts.minDays) };
  });

  const candidates = decorated
    .filter((d) => d.ageDays >= opts.minDays)
    .sort((a, b) => b.ageDays - a.ageDays);

  const texts = new Map();
  const textFor = (ref) => {
    if (texts.has(ref.id)) return texts.get(ref.id);
    let entry;
    try {
      const loaded = opts.load(ref);
      const dialog = dialogText(loaded.records);
      entry = {
        ok: true,
        dialog,
        text: dialog.text.slice(0, opts.maxChars),
        totalChars: dialog.text.length,
        badLines: loaded.badLines || 0,
      };
    } catch (err) {
      entry = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    texts.set(ref.id, entry);
    return entry;
  };

  const poolRefs = decorated
    .slice()
    .sort((a, b) => b.ref.mtimeMs - a.ref.mtimeMs)
    .slice(0, opts.poolLimit)
    .map((d) => d.ref);

  const entries = [];
  for (const cand of candidates) {
    const own = textFor(cand.ref);
    const tier = cand.tier;
    const summaryBudget = tier.budget;
    const retainedBudget = tier.retainedBudget;

    let signals = { keywords: [] };
    let refs = { referenced: false, hits: 0, strong: 0, by: [] };
    if (own.ok) {
      signals = extractSignals(own.text, { limit: opts.signalLimit });
      const pool = poolRefs
        .filter((r) => r.id !== cand.ref.id && r.mtimeMs > cand.ref.mtimeMs)
        .map((r) => {
          const t = textFor(r);
          return { id: r.id, text: t.ok ? t.text : '' };
        });
      refs = detectReferences(signals, pool, { byLimit: opts.byLimit });
    }

    const budget = refs.referenced ? retainedBudget : summaryBudget;
    const summary = own.ok
      ? summarizeText(own.text, budget, signals.keywords)
      : { text: `(读取失败：${own.error})`, picked: 0, truncated: false };

    entries.push({
      id: cand.ref.id,
      workspace: cand.ref.workspace,
      file: cand.ref.file,
      size: cand.ref.size,
      mtimeMs: cand.ref.mtimeMs,
      ageDays: Math.round(cand.ageDays * 10) / 10,
      tier: tier.key,
      tierLabel: tier.label,
      referenced: refs.referenced,
      referencedBy: refs.by,
      referenceHits: refs.hits,
      summaryBudget: budget,
      summary: summary.text,
      summaryTruncated: summary.truncated,
      keywords: signals.keywords.slice(0, 12),
      messages: own.ok ? own.dialog.messages : 0,
      chars: own.ok ? own.totalChars : 0,
      rawTruncated: own.ok ? own.totalChars > opts.maxChars : false,
      error: own.ok ? null : own.error,
      text: own.ok ? own.text : '',
    });
  }

  const counts = { fresh: 0, aging: 0, stale: 0, dormant: 0 };
  for (const d of decorated) counts[d.tier.key] += 1;

  return {
    generatedAt: new Date(now).toISOString(),
    minDays: opts.minDays,
    counts,
    entries,
    stats: {
      sessions: decorated.length,
      skippedFresh: counts.fresh,
      candidates: entries.length,
      referenced: entries.filter((e) => e.referenced).length,
      summaryChars: entries.reduce((n, e) => n + e.summary.length, 0),
      rawChars: entries.reduce((n, e) => n + e.chars, 0),
    },
  };
}

/** 原文文件内容：人可读的转录，不是 JSON dump。 */
function renderRawFile(entry) {
  const head = [
    '# 会话原文导出',
    `id: ${entry.id}`,
    `工作区: ${entry.workspace}`,
    `源文件: ${entry.file}`,
    `最后写入: ${new Date(entry.mtimeMs).toISOString()}`,
    `距今: ${entry.ageDays} 天 · 分档: ${entry.tierLabel}`,
    `原文长度: ${entry.chars} 字符${entry.rawTruncated ? '（已按上限截断）' : ''}`,
    '',
  ];
  return head.join('\n') + '\n' + entry.text + '\n';
}

/** 摘要文件内容：只放摘要与判据，不重复原文。 */
function renderSummaryFile(entry) {
  const lines = [
    `# ${entry.id} · ${entry.tierLabel}`,
    '',
    `- 距今：${entry.ageDays} 天`,
    `- 是否被后续提到：${entry.referenced ? '是 → ' + entry.referencedBy.join(', ') : '否'}`,
    `- 摘要预算：${entry.summaryBudget} 字符（${entry.referenced ? '被引用，保留更多' : '未被引用，按时间精简'}）`,
    `- 关键词：${entry.keywords.join(' / ') || '(无)'}`,
    `- 原文指针：raw/${entry.id}.txt`,
    '',
    '## 摘要',
    '',
    entry.summary || '（该档位不再保留摘要，只留原文指针）',
    '',
  ];
  return lines.join('\n');
}

/**
 * 写盘：index.json + raw/<id>.txt + summaries/<id>.md。
 * @param {string} dir
 * @param {ReturnType<typeof buildArchive>} archive
 * @param {{ dryRun?: boolean }} [opts]
 */
function writeArchive(dir, archive, opts = {}) {
  const root = path.resolve(dir);
  const rawDir = path.join(root, 'raw');
  const summaryDir = path.join(root, 'summaries');
  const indexPath = path.join(root, 'index.json');

  if (opts.dryRun) {
    return { dryRun: true, root, indexPath, rawCount: archive.entries.length, summaryCount: archive.entries.length };
  }

  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(summaryDir, { recursive: true });

  const index = {
    generatedAt: archive.generatedAt,
    minDays: archive.minDays,
    counts: archive.counts,
    stats: archive.stats,
    entries: [],
  };

  for (const entry of archive.entries) {
    const rawRel = path.join('raw', `${entry.id}.txt`).replace(/\\/g, '/');
    const summaryRel = path.join('summaries', `${entry.id}.md`).replace(/\\/g, '/');
    fs.writeFileSync(path.join(root, rawRel), renderRawFile(entry), 'utf8');
    fs.writeFileSync(path.join(root, summaryRel), renderSummaryFile(entry), 'utf8');
    index.entries.push({
      id: entry.id,
      workspace: entry.workspace,
      source: entry.file,
      ageDays: entry.ageDays,
      tier: entry.tier,
      tierLabel: entry.tierLabel,
      referenced: entry.referenced,
      referencedBy: entry.referencedBy,
      summaryBudget: entry.summaryBudget,
      summaryChars: entry.summary.length,
      rawChars: entry.chars,
      raw: rawRel,
      summary: summaryRel,
      rawHash: hashOf(entry.text),
      keywords: entry.keywords.slice(0, 8),
      error: entry.error,
    });
  }

  // index 是查询面：紧凑单行，只放指针/时间/关键词，正文全在 raw/ 与 summaries/
  fs.writeFileSync(indexPath, JSON.stringify(index) + '\n', 'utf8');
  return { dryRun: false, root, indexPath, rawCount: index.entries.length, summaryCount: index.entries.length };
}

/** 终端表格。 */
function renderArchive(archive, opts = {}) {
  const width = Math.max(60, Math.min(opts.width || 78, 120));
  const lines = [];
  const counts = archive.counts || {};
  lines.push('');
  lines.push(`  沉寂内容 · ${archive.entries.length} 个待归档会话  ·  门槛 ${archive.minDays} 天`);
  lines.push(
    `  分档：新鲜 ${counts.fresh || 0} · 渐远 ${counts.aging || 0} · 陈旧 ${counts.stale || 0} · 沉睡 ${counts.dormant || 0}` +
      `  ·  已被提到 ${archive.stats.referenced} 个`,
  );
  lines.push('  ' + '-'.repeat(width - 2));

  if (archive.entries.length === 0) {
    lines.push('  没有超过门槛的会话。');
    lines.push('');
    return lines.join('\n');
  }

  const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n - 1) + '…' : String(s) + ' '.repeat(n - String(s).length));
  lines.push(`  ${pad('分档', 8)}${pad('会话 id', 18)}${pad('天数', 8)}${pad('提到', 8)}${pad('摘要', 8)}原文`);
  for (const e of archive.entries) {
    const mark = e.referenced ? '是' : '否';
    lines.push(
      `  ${pad(e.tierLabel, 8)}${pad(e.id, 18)}${pad(e.ageDays + 'd', 8)}${pad(mark, 8)}` +
        `${pad(e.summary.length + '字', 8)}raw/${e.id}.txt`,
    );
  }
  lines.push('');
  lines.push(`  摘要合计 ${archive.stats.summaryChars} 字符 · 原文合计 ${archive.stats.rawChars} 字符（分开存放）`);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  TIERS,
  tierOf,
  ageInDays,
  recordText,
  dialogText,
  extractSignals,
  detectReferences,
  summarizeText,
  buildArchive,
  writeArchive,
  renderArchive,
  renderRawFile,
  renderSummaryFile,
};
