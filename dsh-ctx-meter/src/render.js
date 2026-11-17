'use strict';

/**
 * Terminal rendering. Plain text, no dependencies, no box-drawing requirement.
 *
 * Width handling matters here: CJK characters occupy two terminal columns while
 * a JavaScript string counts them as one, so every padded column goes through
 * `padEnd` below instead of `String.prototype.padEnd`.
 */

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const GLYPH_UNICODE = { full: '█', empty: '░', rule: '─', dot: '·' };
const GLYPH_ASCII = { full: '#', empty: '.', rule: '-', dot: '|' };

/** East-Asian wide / emoji code points occupy two columns in most terminals. */
function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    ? 2
    : 1;
}

/** @param {string} text */
function displayWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0));
  return width;
}

/** @param {string} text */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pad to a display width, truncating with an ellipsis when needed.
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} [align]
 */
function pad(text, width, align = 'left') {
  const str = String(text);
  const w = displayWidth(str);
  if (w === width) return str;
  if (w > width) {
    let out = '';
    let used = 0;
    for (const ch of stripAnsi(str)) {
      const cw = charWidth(ch.codePointAt(0));
      if (used + cw > width - 1) break;
      out += ch;
      used += cw;
    }
    const tail = width - used > 0 ? '…' + ' '.repeat(Math.max(0, width - used - 1)) : '';
    return out + tail;
  }
  const gap = ' '.repeat(width - w);
  return align === 'right' ? gap + str : str + gap;
}

/**
 * @param {number} value
 * @returns {string} grouped integer, e.g. 12345 -> "12,345"
 */
function formatTokens(value) {
  const n = Math.round(Number(value) || 0);
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Compact human form for very large counts: 1.2M, 34.7k.
 * @param {number} value
 */
function formatCompact(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return formatTokens(n);
}

/**
 * @param {number} ratio 0..1
 * @param {number} width
 * @param {{ full: string, empty: string }} glyph
 */
function bar(ratio, width, glyph) {
  const safe = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(safe * width);
  return glyph.full.repeat(filled) + glyph.empty.repeat(Math.max(0, width - filled));
}

/**
 * Build a colorizer. Color is off for pipes, `--no-color`, NO_COLOR, and dumb terminals.
 * @param {{ color?: boolean }} [opts]
 */
function createStyler(opts = {}) {
  const enabled = opts.color === true;
  const wrap = (code) => (text) => (enabled ? `${code}${text}${ANSI.reset}` : String(text));
  return {
    enabled,
    bold: wrap(ANSI.bold),
    dim: wrap(ANSI.dim),
    red: wrap(ANSI.red),
    green: wrap(ANSI.green),
    yellow: wrap(ANSI.yellow),
    cyan: wrap(ANSI.cyan),
    magenta: wrap(ANSI.magenta),
  };
}

/**
 * Percent shown with one decimal below 10% so "3.2%" is not rounded to "3%".
 * @param {number} percent
 */
function formatPercent(percent) {
  if (percent == null || !Number.isFinite(percent)) return '?';
  return percent >= 10 ? `${percent.toFixed(1)}%` : `${percent.toFixed(2)}%`;
}

/** @param {string} iso */
function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Render the full report.
 * @param {ReturnType<import('./accounting').analyze>} report
 * @param {{ color?: boolean, ascii?: boolean, width?: number }} [opts]
 */
function renderReport(report, opts = {}) {
  const style = createStyler({ color: opts.color });
  const glyph = opts.ascii ? GLYPH_ASCII : GLYPH_UNICODE;
  const width = Math.max(72, Math.min(opts.width || 78, 120));
  const indent = '  ';
  const labelWidth = 14;
  const lines = [];

  const rule = () => style.dim(glyph.rule.repeat(width));
  const section = (title) => {
    lines.push('');
    lines.push(style.bold(title));
  };

  // ---- header -----------------------------------------------------------
  lines.push('');
  lines.push(style.bold('  dsh-ctx') + style.dim('  ·  DeepSeek Harness context meter'));
  lines.push(rule());

  const created =
    formatDate(report.session.createdAt) +
    (report.session.preset ? style.dim(`  ·  preset ${report.session.preset}`) : '');
  const metaRows = [
    ['会话', report.session.id],
    ['工作区', report.session.cwd || style.dim('(未记录)')],
    ['创建', created],
    [
      '模型',
      [report.model.name || 'unknown', report.model.provider && `(${report.model.provider})`]
        .filter(Boolean)
        .join(' '),
    ],
  ];
  for (const [k, v] of metaRows) {
    lines.push(`${indent}${style.dim(pad(k, labelWidth))}${v}`);
  }

  // ---- live context -----------------------------------------------------
  section('上下文占用');
  const cur = report.current;
  if (!cur.measured) {
    lines.push(`${indent}${style.yellow('没有找到 usage 记录，无法给出实测占用。')}`);
  } else {
    const pct = cur.percent;
    const ratio = pct == null ? 0 : pct / 100;
    const barWidth = 30;
    const color = pct == null ? style.dim : pct >= 90 ? style.red : pct >= 70 ? style.yellow : style.green;
    lines.push(
      `${indent}${color(bar(ratio, barWidth, glyph))}  ` +
        style.bold(`${formatTokens(cur.tokens)}`) +
        (cur.window ? style.dim(` / ${formatTokens(cur.window)}`) : '') +
        `  ${color(formatPercent(pct))}`,
    );
    const parts = [
      `未命中输入 ${formatTokens(cur.input)}`,
      `缓存命中 ${formatTokens(cur.cacheRead)}${
        cur.cacheHitRate != null ? style.dim(` (${(cur.cacheHitRate * 100).toFixed(1)}%)`) : ''
      }`,
    ];
    if (cur.cacheWrite) parts.push(`缓存写入 ${formatTokens(cur.cacheWrite)}`);
    lines.push(`${indent}${style.dim(parts.join(' · '))}`);

    if (report.pending.records > 0) {
      lines.push(
        `${indent}${style.dim('最后一次请求之后新增')} ${formatTokens(report.pending.records)} ` +
          `${style.dim('条记录 ≈ ')}${style.yellow(`~${formatTokens(report.pending.tokens)}`)}${style.dim(' tokens（估算）')}`,
      );
    }
  }

  // ---- ledger -----------------------------------------------------------
  section('token 账单（全会话 · 实测）');
  const led = report.ledger;
  const ledRows = [
    ['未命中输入', led.input, ''],
    ['缓存命中', led.cacheRead, ''],
    ['缓存写入', led.cacheWrite, ''],
    ['输出', led.output, ''],
  ].filter((row, i) => i !== 2 || led.cacheWrite > 0);
  const numWidth = Math.max(...ledRows.map((r) => formatTokens(r[1]).length), 10);
  for (const [k, v] of ledRows) {
    lines.push(`${indent}${style.dim(pad(k, labelWidth))}${style.cyan(pad(formatTokens(v), numWidth, 'right'))}`);
  }
  lines.push(`${indent}${style.dim(glyph.rule.repeat(labelWidth + numWidth))}`);
  lines.push(
    `${indent}${style.dim(pad('合计', labelWidth))}${style.bold(style.cyan(pad(formatTokens(led.total), numWidth, 'right')))}`,
  );
  lines.push(
    `${indent}${style.dim(`${formatTokens(led.requests)} 次请求，平均每次提示 ${formatTokens(led.requests ? led.promptTotal / led.requests : 0)} tokens`)}`,
  );

  // ---- compaction -------------------------------------------------------
  section('压缩');
  const comp = report.compactionTotals;
  if (comp.count === 0) {
    lines.push(`${indent}${style.dim('尚未发生上下文压缩。')}`);
  } else {
    lines.push(
      `${indent}${style.dim(pad('次数', labelWidth))}${style.bold(String(comp.count))}` +
        style.dim('   每挤掉一批记录就是一次「失忆」'),
    );
    lines.push(
      `${indent}${style.dim(pad('挤出的上下文', labelWidth))}${style.magenta(formatTokens(comp.shadowedTokens))}` +
        style.dim(' tokens（累计被移出上下文的量）'),
    );
    if (comp.ownPrompt || comp.ownOutput) {
      lines.push(
        `${indent}${style.dim(pad('压缩自身消耗', labelWidth))}${formatTokens(comp.ownPrompt + comp.ownOutput)}` +
          style.dim(`  (提示 ${formatTokens(comp.ownPrompt)} + 输出 ${formatTokens(comp.ownOutput)})`),
      );
    }
    const last = report.compactions[report.compactions.length - 1];
    if (last) {
      const tail = [
        `seq ${last.seq ?? '?'}`,
        last.shadowedTokens ? `挤出 ${formatTokens(last.shadowedTokens)}` : null,
        last.shadowedRecords != null ? `${last.shadowedRecords} 条记录` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(`${indent}${style.dim(pad('最近一次', labelWidth))}${style.dim(tail)}`);
    }
  }

  // ---- breakdown --------------------------------------------------------
  section('预算花在哪（当前上下文 · 按实测总量分摊）');
  const breakdown = report.active.breakdown;
  if (breakdown.length === 0) {
    lines.push(`${indent}${style.dim('压缩之后还没有内容记录。')}`);
  } else {
    const nameWidth = 16;
    const barWidth = 22;
    const tokWidth = Math.max(...breakdown.map((b) => formatTokens(b.tokens).length), 8);
    for (const item of breakdown) {
      lines.push(
        `${indent}${pad(item.label, nameWidth)}` +
          `${style.dim(bar(item.share, barWidth, glyph))}  ` +
          `${style.cyan(pad(formatTokens(item.tokens), tokWidth, 'right'))}  ` +
          `${style.dim(formatPercent(item.share * 100))}` +
          style.dim(`  ${formatTokens(item.records)} 条`),
      );
    }
    if (report.overhead.tools > 0) {
      lines.push(
        `${indent}${style.dim(
          `其中「请求头」= ${report.overhead.tools} 个工具定义 / ${formatTokens(report.overhead.toolsChars)} 字符，` +
            '每次请求都会重发',
        )}`,
      );
    }
  }

  // ---- biggest records --------------------------------------------------
  if (report.active.top.length > 0) {
    section(`最占地方的 ${report.active.top.length} 条记录`);
    const seqWidth = 6;
    for (const item of report.active.top) {
      lines.push(
        `${indent}${style.dim(pad(`#${item.seq ?? '?'}`, seqWidth))}` +
          `${pad(item.label, Math.max(12, width - 2 - seqWidth - 12))}` +
          `${style.cyan(pad(formatCompact(item.tokens), 7, 'right'))}`,
      );
    }
  }

  // ---- volume -----------------------------------------------------------
  section('体量');
  const volume = report.volume;
  const topTypes = Object.entries(volume.typeCounts).slice(0, 6);
  lines.push(
    `${indent}${style.dim(pad('记录总数', labelWidth))}${formatTokens(volume.records)}  ` +
      style.dim(
        `(${topTypes
          .map(([k, n]) => `${k} ${formatTokens(n)}`)
          .join(' · ')}${Object.keys(volume.typeCounts).length > topTypes.length ? ' …' : ''})`,
      ),
  );
  const decoded = report.decode;
  if (decoded) {
    lines.push(
      `${indent}${style.dim(pad('文件', labelWidth))}${formatTokens(decoded.compressed)} 字节压缩` +
        style.dim(
          ` → ${formatCompact(decoded.frames)} 个 zstd 帧 → ${formatCompact(decoded.chars)} 字符` +
            (decoded.badLines ? ` · ${decoded.badLines} 行解析失败` : ''),
        ),
    );
  }

  lines.push('');
  lines.push(rule());
  lines.push(
    style.dim(
      `${indent}实测 = provider 回报的 usage；估算 = 按字符密度推算的分摊值。` +
        (!style.enabled ? '' : '') +
        `\n${indent}--json 取机器可读输出，--list 看全部会话，--help 看用法。`,
    ),
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Render the session list.
 * @param {import('./store').SessionRef[]} sessions
 * @param {{ color?: boolean, ascii?: boolean, currentFile?: string }} [opts]
 */
function renderList(sessions, opts = {}) {
  const style = createStyler({ color: opts.color });
  const lines = [];
  lines.push('');
  lines.push(style.bold('  会话列表') + style.dim(`  ·  ${sessions.length} 个`));
  lines.push(style.dim('  ' + '-'.repeat(76)));
  lines.push(
    `  ${style.dim(pad('大小', 9))}${style.dim(pad('最后写入', 18))}${style.dim(pad('会话 id', 22))}${style.dim('工作区')}`,
  );
  for (const s of sessions) {
    const d = new Date(s.mtimeMs);
    const p = (n) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const mark = opts.currentFile === s.file ? style.green('* ') : '  ';
    lines.push(
      `${mark}${pad(formatCompact(s.size) + 'B', 9)}${pad(when, 18)}` +
        `${style.cyan(pad(s.id.slice(0, 20), 22))}${style.dim(truncate(s.workspace, 40))}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** @param {string} text @param {number} max */
function truncate(text, max) {
  const str = String(text);
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

module.exports = {
  renderReport,
  renderList,
  formatTokens,
  formatCompact,
  formatPercent,
  formatDate,
  pad,
  displayWidth,
  bar,
  createStyler,
  truncate,
};
