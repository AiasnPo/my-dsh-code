'use strict';

/**
 * Accounting for a DeepSeek Harness session.
 *
 * Everything here is derived from what the session file already recorded. Two
 * kinds of numbers are kept strictly apart so the report can label them honestly:
 *
 *   measured   token counts that the provider reported back in
 *              `assistant/message.usage` — these are facts
 *   estimated  character counts (and character-derived token shares) for content
 *              that never carried a usage record — these are approximations
 *
 * The one place where the two meet is the per-record breakdown: the *total* is
 * measured, the split between record kinds is apportioned by character share and
 * labelled as such.
 */

/** Record types that carry observable conversation content. */
const CONTENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'system/message',
  'request/header',
  'request/context',
]);

/** Short human labels for record kinds. */
const TYPE_LABELS = {
  'user/message': '用户消息',
  'assistant/message': '助手消息',
  'tool/call': '工具调用',
  'tool/result': '工具结果',
  'system/message': '系统消息',
  'request/header': '请求头(工具定义)',
  'request/context': '请求上下文',
  'compaction/summary': '压缩摘要',
};

/**
 * Depth-first search for the first occurrence of one of `keys`.
 * Session payload shapes are not guaranteed to stay flat across versions, so
 * probing beats hard-coding a path.
 * @param {unknown} value
 * @param {string[]} keys
 * @param {number} [depth]
 */
function probe(value, keys, depth = 4) {
  if (!value || typeof value !== 'object' || depth < 0) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = probe(child, keys, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** @param {any} usage */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = {
    input: num(usage.inputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    output: num(usage.outputTokens),
    total: num(usage.totalTokens),
  };
  if (out.total === 0) out.total = out.input + out.cacheRead + out.cacheWrite + out.output;
  out.prompt = out.input + out.cacheRead + out.cacheWrite;
  return out;
}

/**
 * Approximate token count from raw text, used only for content that has no
 * measured usage. CJK characters run close to one token each, Latin text close
 * to one token per four characters.
 * @param {string} text
 */
function estimateTokens(text) {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals through unified ideographs
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0x3000 && cp <= 0x303f) // CJK punctuation
    ) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.round(wide + narrow / 3.7);
}

/**
 * One short line describing what a record is about, for ranked listings.
 * @param {Record<string, any>} rec
 * @returns {string}
 */
function describeRecord(rec) {
  const data = rec.data || {};
  const kind = rec.type || 'unknown';
  const label = TYPE_LABELS[kind] || kind;
  let detail = '';
  if (kind === 'tool/call') {
    const name = probe(data, ['name', 'tool', 'toolName'], 2);
    const input = probe(data, ['input', 'arguments', 'args', 'parameters'], 2);
    detail = [name, input && JSON.stringify(input)].filter(Boolean).join(' ');
  } else if (kind === 'tool/result') {
    const name = probe(data, ['name', 'tool', 'toolName'], 2);
    const text = recordText(rec);
    detail = [name, text].filter(Boolean).join(' ');
  } else if (kind === 'user/message' || kind === 'assistant/message' || kind === 'system/message') {
    detail = recordText(rec);
  } else if (kind === 'request/header') {
    const tools = probe(data, ['tools'], 2);
    detail = Array.isArray(tools) ? `${tools.length} 个工具定义` : '';
  } else if (kind === 'request/context') {
    const model = probe(data, ['model'], 2);
    detail = typeof model === 'string' ? model : '';
  }
  const oneLine = String(detail).replace(/\s+/g, ' ').trim();
  return oneLine ? `${label} · ${oneLine}` : label;
}

/**
 * Best-effort text of a message record, across possible payload shapes.
 * @param {Record<string, any>} rec
 */
function recordText(rec) {
  const data = rec.data || {};
  const candidate = probe(data, ['text', 'content', 'message', 'body'], 3);
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(candidate)) {
    const parts = [];
    for (const part of candidate) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const t = probe(part, ['text', 'content'], 2);
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join(' ');
  }
  return '';
}

/** @param {Record<string, any>} rec */
function recordChars(rec) {
  try {
    return JSON.stringify(rec).length;
  } catch {
    return 0;
  }
}

/**
 * Normalise a session timestamp to ISO-8601. Harness writes millisecond epoch
 * numbers in `session.createdAt` and `time` on every record, but older logs
 * (and hand-edited fixtures) may carry seconds or a date string.
 * @param {unknown} value
 * @returns {string} ISO string, or '' when the value is unusable
 */
function toIso(value) {
  if (value == null || value === '') return '';
  let n = value;
  if (typeof n === 'string') {
    if (!/^\d+$/.test(n)) {
      const parsed = new Date(n);
      return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
    }
    n = Number(n);
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const ms = n < 1e12 ? n * 1000 : n; // 10-digit values are seconds
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Full analysis of one session.
 * @param {import('./store').SessionRef} ref
 * @param {Record<string, any>[]} records
 * @param {{ topN?: number }} [opts]
 */
function analyze(ref, records, opts = {}) {
  const topN = opts.topN ?? 8;

  // ---- session identity -------------------------------------------------
  const meta = records.find((r) => r && r.type === 'session') || {};
  const firstTime = records.find((r) => r && typeof r.time === 'number');
  const session = {
    id: meta.id || ref.id,
    file: ref.file,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
    createdAt: toIso(meta.createdAt) || toIso(firstTime && firstTime.time),
    version: meta.version ?? null,
    preset: typeof meta.agentPreset === 'string' ? meta.agentPreset : '',
    delegationDepth: typeof meta.delegationDepth === 'number' ? meta.delegationDepth : null,
  };

  // ---- model and window -------------------------------------------------
  const contexts = records.filter((r) => r && r.type === 'request/context');
  const lastContext = contexts[contexts.length - 1];
  const model = probe(lastContext && lastContext.data, ['model'], 3);
  const provider = probe(lastContext && lastContext.data, ['provider'], 3);
  const contextWindow = probe(lastContext && lastContext.data, ['contextWindow', 'maxTokens'], 3);

  // ---- measured usage ---------------------------------------------------
  const withUsage = records
    .filter((r) => r && r.type === 'assistant/message')
    .map((r) => ({ rec: r, usage: normalizeUsage(probe(r.data, ['usage'], 3)) }))
    .filter((x) => x.usage && x.usage.total > 0);

  const ledger = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  for (const { usage } of withUsage) {
    ledger.input += usage.input;
    ledger.cacheRead += usage.cacheRead;
    ledger.cacheWrite += usage.cacheWrite;
    ledger.output += usage.output;
    ledger.total += usage.total;
  }
  ledger.requests = withUsage.length;
  ledger.promptTotal = ledger.input + ledger.cacheRead + ledger.cacheWrite;

  const lastMeasured = withUsage[withUsage.length - 1];
  const current = {
    tokens: lastMeasured ? lastMeasured.usage.prompt : 0,
    window: typeof contextWindow === 'number' ? contextWindow : null,
    atSeq: lastMeasured ? lastMeasured.rec.seq : null,
    input: lastMeasured ? lastMeasured.usage.input : 0,
    cacheRead: lastMeasured ? lastMeasured.usage.cacheRead : 0,
    cacheWrite: lastMeasured ? lastMeasured.usage.cacheWrite : 0,
    output: lastMeasured ? lastMeasured.usage.output : 0,
    measured: Boolean(lastMeasured),
  };
  current.percent = current.window ? (current.tokens / current.window) * 100 : null;
  current.cacheHitRate = current.tokens ? current.cacheRead / current.tokens : null;

  // ---- compactions ------------------------------------------------------
  const compactions = records
    .filter((r) => r && r.type === 'compaction/summary')
    .map((r) => {
      const shadowed = probe(r.data, ['shadowedTokenCount'], 3);
      const seqs = probe(r.data, ['shadowedSeqs'], 3);
      const range = probe(r.data, ['shadowedRange'], 3);
      const usage = normalizeUsage(probe(r.data, ['usage'], 3));
      return {
        seq: r.seq,
        shadowedTokens: typeof shadowed === 'number' ? shadowed : 0,
        shadowedRecords: Array.isArray(seqs) ? seqs.length : null,
        shadowedRange: range || null,
        prompt: usage ? usage.prompt : 0,
        output: usage ? usage.output : 0,
      };
    });
  const compactionTotals = {
    count: compactions.length,
    shadowedTokens: compactions.reduce((n, c) => n + c.shadowedTokens, 0),
    ownPrompt: compactions.reduce((n, c) => n + c.prompt, 0),
    ownOutput: compactions.reduce((n, c) => n + c.output, 0),
  };

  // ---- active window ----------------------------------------------------
  const endSeqs = records
    .filter((r) => r && r.type === 'compaction/end' && typeof r.seq === 'number')
    .map((r) => r.seq);
  const sinceSeq = endSeqs.length ? Math.max(...endSeqs) : -1;
  const activeRecords = records.filter(
    (r) => r && CONTENT_TYPES.has(r.type) && typeof r.seq === 'number' && r.seq > sinceSeq,
  );
  const activeChars = activeRecords.reduce((n, r) => n + recordChars(r), 0);

  // Headers are re-sent with every request, so the last one is the live cost of
  // tool definitions and is counted inside the request that produced `current`.
  const headers = records.filter((r) => r && r.type === 'request/header');
  const lastHeader = headers[headers.length - 1];
  const tools = lastHeader ? probe(lastHeader.data, ['tools'], 2) : undefined;
  const toolsJson = Array.isArray(tools) ? JSON.stringify(tools) : '';
  const toolsChars = toolsJson.length;
  const overhead = {
    tools: Array.isArray(tools) ? tools.length : 0,
    toolsChars,
    toolsTokens: estimateTokens(toolsJson),
  };

  // ---- apportion the live prompt by character share ---------------------
  // The denominator mirrors what the last measured request actually carried:
  // the live header plus every content record after the last compaction. The
  // numerator is measured, so the resulting ratio converts characters into
  // tokens at this session's own observed density.
  const headerChars = toolsChars;
  const denominator = activeChars + headerChars;
  const density = denominator > 0 && current.tokens > 0 ? current.tokens / denominator : 0;

  /** @type {Map<string, {type: string, label: string, chars: number, records: number}>} */
  const byType = new Map();
  for (const rec of activeRecords) {
    const key = rec.type;
    const entry = byType.get(key) || {
      type: key,
      label: TYPE_LABELS[key] || key,
      chars: 0,
      records: 0,
    };
    entry.chars += recordChars(rec);
    entry.records += 1;
    byType.set(key, entry);
  }
  if (headerChars > 0) {
    const entry = byType.get('request/header') || {
      type: 'request/header',
      label: TYPE_LABELS['request/header'],
      chars: 0,
      records: 0,
    };
    entry.chars += headerChars;
    entry.records = Math.max(entry.records, 1);
    byType.set('request/header', entry);
  }

  const breakdown = [...byType.values()]
    .map((e) => ({
      ...e,
      tokens: density > 0 ? Math.round(e.chars * density) : Math.round(e.chars / 3.7),
      share: denominator > 0 ? e.chars / denominator : 0,
    }))
    .sort((a, b) => b.chars - a.chars);

  const ranked = activeRecords
    .map((rec) => ({ rec, chars: recordChars(rec) }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, topN)
    .map(({ rec, chars }) => ({
      seq: rec.seq,
      type: rec.type,
      label: describeRecord(rec),
      chars,
      tokens: density > 0 ? Math.round(chars * density) : Math.round(chars / 3.7),
    }));

  // ---- what arrived after the last measured request ---------------------
  const afterMeasured = lastMeasured
    ? records.filter(
        (r) => r && CONTENT_TYPES.has(r.type) && typeof r.seq === 'number' && r.seq > lastMeasured.rec.seq,
      )
    : [];
  const afterChars = afterMeasured.reduce((n, r) => n + recordChars(r), 0);
  const pending = {
    records: afterMeasured.length,
    chars: afterChars,
    tokens: density > 0 ? Math.round(afterChars * density) : Math.round(afterChars / 3.7),
  };

  // ---- volume -----------------------------------------------------------
  const typeCounts = new Map();
  for (const rec of records) {
    const key = rec && rec.type ? rec.type : 'unknown';
    typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
  }

  return {
    session,
    model: {
      name: typeof model === 'string' ? model : '',
      provider: typeof provider === 'string' ? provider : '',
      contextWindow: typeof contextWindow === 'number' ? contextWindow : null,
    },
    current,
    ledger,
    compactions,
    compactionTotals,
    active: {
      sinceSeq,
      records: activeRecords.length,
      chars: activeChars,
      density,
      breakdown,
      top: ranked,
    },
    overhead,
    pending,
    volume: {
      records: records.length,
      typeCounts: Object.fromEntries([...typeCounts.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}

module.exports = {
  analyze,
  probe,
  normalizeUsage,
  estimateTokens,
  describeRecord,
  recordText,
  recordChars,
  TYPE_LABELS,
  CONTENT_TYPES,
};
