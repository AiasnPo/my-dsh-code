#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveSessionRoot, listSessions, pickSession, loadSession } = require('../src/store');
const { analyze } = require('../src/accounting');
const { renderReport, renderList, formatPercent, formatTokens, formatCompact } = require('../src/render');
const { buildArchive, writeArchive, renderArchive } = require('../src/stale');
const { purgeSessions, renderPurge } = require('../src/purge');
const { slimSessions, appendSlimLog, renderSlim } = require('../src/slim');

const pkg = require('../package.json');

const EXIT = { ok: 0, failure: 1, usage: 2, threshold: 3 };

const HELP = `
dsh-ctx · DeepSeek Harness 上下文账本

看清一个会话到底吃掉了多少上下文：每次请求的真实 token、压缩历史、
以及当前预算花在哪些记录上。

用法
  dsh-ctx [选项]

选项
  -l, --list              列出全部会话，不生成报告
      --stale             陈旧内容检测：把久未提及的老对话的原文与摘要分开归档
      --purge             归档成功后删掉原会话目录（默认只预览，需 --yes 才真删）
      --slim              给长期不活跃的会话瘦身：裁掉老工具输出/推理，重写文件
-y, --yes                真正执行 --purge / --slim（不加则一律预览）
  -s, --session <id|路径>  指定会话（id 前缀或 session 目录路径）
      --root <目录>        会话根目录（默认自动探测：$DSH_SESSIONS_DIR、$DSH_PROFILE_DIR/sessions、$DSH_HOME/sessions、~/.dsh/sessions）
      --all-workspaces     包含插件内部工作区（默认跳过）
      --top <n>            列出最占地方的 n 条记录（默认 8）
      --width <n>          输出宽度（默认 78，最小 72）
      --json               输出机器可读的 JSON
      --ascii              用 ASCII 字符画进度条
      --no-color           关闭颜色
      --fail-if-over <pct> 占用超过该百分比时以退出码 3 结束（便于脚本监控）

陈旧检测（配合 --stale）
      --days <n>           只归档超过 n 天的会话（默认 30）
      --archive-dir <目录> 归档输出目录（默认 ./dsh-ctx-archive）
      --dry-run            只报告不写盘
      --now <ISO时间>      以指定时间为“现在”，便于回放与测试
      --pool-limit <n>     取最近 n 个会话作为“是否再被提及”的比对池（默认 24）

删除与瘦身（降低上下文负担，都会先预览）
      --purge              先归档、确认归档完整后，删掉超过 --days 天的会话目录
      --slim               给 mtime 超过 30 天的会话裁掉老工具输出与推理原文
      --min-age <n>        瘦身门槛天数（默认 30；比这更近的会话不动）
      --no-backup          瘦身时不留 *.bak 备份（默认留）
  -y, --yes                真正执行；不加时 --purge/--slim 都是预览
  -v, --version           版本号
  -h, --help              本帮助

退出码
  0 正常   1 读取失败   2 参数错误   3 超过 --fail-if-over 阈值

示例
  dsh-ctx                             # 最新会话的完整报告
  dsh-ctx --list                      # 所有会话
  dsh-ctx -s 443c60eb                 # 按 id 前缀挑选
  dsh-ctx --json | jq '.current'      # 只看当前占用
  dsh-ctx --fail-if-over 80           # CI / 脚本里当水位告警
  dsh-ctx --stale                     # 把陈旧的会话原文与摘要分开归档
  dsh-ctx --stale --days 60 --dry-run # 只看 60 天以上、不写盘
  dsh-ctx --purge                     # 预览：哪些老会话会被归档后删掉
  dsh-ctx --purge --days 90 --yes     # 先归档，再删掉 90 天以上的会话
  dsh-ctx --slim                      # 预览：老会话能省多少字符
  dsh-ctx --slim --min-age 30 --yes   # 真给老会话瘦身（留 .bak）
`;

/**
 * @typedef {object} Args
 * @property {boolean} list
 * @property {boolean} stale
 * @property {boolean} purge
 * @property {boolean} slim
 * @property {boolean} yes
 * @property {number|undefined} minAge
 * @property {boolean} backup
 * @property {string|undefined} session
 * @property {string|undefined} root
 * @property {string|undefined} archiveDir
 * @property {number|undefined} days
 * @property {boolean} dryRun
 * @property {string|undefined} now
 * @property {number|undefined} poolLimit
 * @property {boolean} allWorkspaces
 * @property {number} top
 * @property {number} width
 * @property {boolean} json
 * @property {boolean} ascii
 * @property {boolean} color
 * @property {number|undefined} failIfOver
 * @property {boolean} help
 * @property {boolean} version
 * @property {string[]} unknown
 */

/**
 * Parse CLI arguments. Unknown flags are collected rather than ignored silently.
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
  const args = {
    list: false,
    stale: false,
    purge: false,
    slim: false,
    yes: false,
    minAge: undefined,
    backup: true,
    session: undefined,
    root: undefined,
    archiveDir: undefined,
    days: undefined,
    dryRun: false,
    now: undefined,
    poolLimit: undefined,
    allWorkspaces: false,
    top: 8,
    width: 78,
    json: false,
    ascii: false,
    color: true,
    failIfOver: undefined,
    help: false,
    version: false,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw usageError(`${flag} 需要一个值`);
      return argv[i];
    };

    switch (flag) {
      case '-l':
      case '--list':
        args.list = true;
        break;
      case '--stale':
        args.stale = true;
        break;
      case '--purge':
        args.purge = true;
        break;
      case '--slim':
        args.slim = true;
        break;
      case '-y':
      case '--yes':
        args.yes = true;
        break;
      case '--min-age': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw usageError('--min-age 需要非负整数');
        args.minAge = n;
        break;
      }
      case '--no-backup':
        args.backup = false;
        break;
      case '--archive-dir':
        args.archiveDir = value();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--now': {
        const raw = value();
        if (Number.isNaN(Date.parse(raw))) throw usageError('--now 需要可解析的时间，如 2026-11-16T00:00:00Z');
        args.now = raw;
        break;
      }
      case '--days': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw usageError('--days 需要非负整数');
        args.days = n;
        break;
      }
      case '--pool-limit': {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0) throw usageError('--pool-limit 需要正整数');
        args.poolLimit = n;
        break;
      }
      case '-s':
      case '--session':
        args.session = value();
        break;
      case '--root':
        args.root = value();
        break;
      case '--all-workspaces':
        args.allWorkspaces = true;
        break;
      case '--top': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw usageError('--top 需要非负整数');
        args.top = n;
        break;
      }
      case '--width': {
        const n = Number(value());
        if (!Number.isFinite(n)) throw usageError('--width 需要数字');
        args.width = n;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--ascii':
        args.ascii = true;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '--fail-if-over': {
        const n = Number(value());
        if (!Number.isFinite(n) || n <= 0) throw usageError('--fail-if-over 需要正数百分比');
        args.failIfOver = n;
        break;
      }
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (/^-[a-zA-Z]/.test(flag)) args.unknown.push(flag);
        break;
    }
  }

  if (args.unknown.length > 0) {
    throw usageError(`未知选项：${args.unknown.join(' ')}`);
  }

  if (args.purge && args.slim) {
    throw usageError('--purge 与 --slim 一次只能用其中一个（可先 --slim 瘦身，再 --purge 删除）');
  }

  const envNoColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
  const dumb = process.env.TERM === 'dumb';
  args.color = args.color && !envNoColor && !dumb && Boolean(process.stdout.isTTY);

  return args;
}

/** @param {string} message */
function usageError(message) {
  const err = new Error(message);
  err.code = 'EUSAGE';
  return err;
}

/** @param {Args} args */
function run(args) {
  const { root, tried } = resolveSessionRoot(args.root);
  if (!fs.existsSync(root)) {
    const err = new Error(
      `找不到会话目录。已尝试：\n${tried.map((t) => `  ${t}`).join('\n')}\n` +
        '用 --root <目录> 指定会话根目录，或先跑一次 dsh 让会话落地。',
    );
    err.code = 'ENO_SESSION_ROOT';
    throw err;
  }

  const sessions = listSessions(root);

  if (args.list) {
    if (sessions.length === 0) {
      const err = new Error(`没有在 ${root} 下找到任何会话文件`);
      err.code = 'ENO_SESSION';
      throw err;
    }
    const shown = args.allWorkspaces ? sessions : sessions.filter((s) => !s.internal);
    if (args.json) {
      process.stdout.write(JSON.stringify({ root, sessions: shown }, null, 2) + '\n');
      return EXIT.ok;
    }
    process.stdout.write(
      renderList(shown.length ? shown : sessions, {
        color: args.color,
        ascii: args.ascii,
      }),
    );
    return EXIT.ok;
  }

  const archiveDirOf = () =>
    args.archiveDir ? path.resolve(args.archiveDir) : path.join(process.cwd(), 'dsh-ctx-archive');

  if (args.stale) {
    const archiveDir = archiveDirOf();
    const archive = buildArchive({
      sessions,
      load: (r) => loadSession(r),
      now: args.now ? Date.parse(args.now) : Date.now(),
      minDays: args.days === undefined ? 30 : args.days,
      poolLimit: args.poolLimit || 24,
      includeInternal: args.allWorkspaces,
    });
    const written = writeArchive(archiveDir, archive, { dryRun: args.dryRun });
    if (args.json) {
      const view = {
        ...archive,
        entries: archive.entries.map(({ text, ...rest }) => rest),
        output: {
          root: written.root,
          indexPath: written.indexPath,
          written: !written.dryRun,
        },
      };
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return EXIT.ok;
    }
    process.stdout.write(renderArchive(archive, { width: args.width }));
    process.stdout.write(
      written.dryRun
        ? `  dry-run：未写盘（目标 ${written.indexPath}）\n`
        : `  已写入 ${written.indexPath}（原文 raw/ · 摘要 summaries/）\n`,
    );
    return EXIT.ok;
  }

  if (args.purge) {
    const dryRun = !args.yes || args.dryRun;
    const outcome = purgeSessions({
      sessions,
      load: (r) => loadSession(r),
      archiveDir: archiveDirOf(),
      now: args.now ? Date.parse(args.now) : Date.now(),
      minDays: args.days === undefined ? 30 : args.days,
      poolLimit: args.poolLimit || 24,
      includeInternal: args.allWorkspaces,
      dryRun,
    });
    if (args.json) {
      const view = {
        root,
        dryRun,
        archive: {
          root: outcome.written.root,
          indexPath: outcome.written.indexPath,
          minDays: outcome.archive.minDays,
          counts: outcome.archive.counts,
        },
        summary: outcome.summary,
        results: outcome.results,
        error: outcome.error,
      };
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return outcome.error ? EXIT.failure : EXIT.ok;
    }
    process.stdout.write(renderPurge(outcome, { width: args.width, dryRun }));
    return outcome.error ? EXIT.failure : EXIT.ok;
  }

  if (args.slim) {
    const dryRun = !args.yes || args.dryRun;
    const minAgeDays = args.minAge === undefined ? 30 : args.minAge;
    const targets = args.allWorkspaces ? sessions : sessions.filter((s) => !s.internal);
    const now = args.now ? Date.parse(args.now) : Date.now();
    const report = slimSessions({
      sessions: targets,
      load: (r) => loadSession(r),
      opts: { minAgeDays, backup: args.backup, dryRun },
    });
    const logPath = dryRun ? null : appendSlimLog(archiveDirOf(), report.results, now);
    if (args.json) {
      const view = {
        root,
        dryRun,
        minAgeDays,
        summary: report.summary,
        results: report.results.map(({ plan, ...rest }) => ({
          ...rest,
          hits: plan ? { count: plan.hits.length, byKind: plan.byKind } : undefined,
        })),
        log: logPath,
      };
      process.stdout.write(JSON.stringify(view, null, 2) + '\n');
      return EXIT.ok;
    }
    process.stdout.write(renderSlim(report, { width: args.width, minAgeDays, dryRun }));
    if (logPath) process.stdout.write(`  瘦身记录 ${logPath}\n`);
    return EXIT.ok;
  }

  const ref = pickSession({
    root,
    sessions,
    query: args.session,
    includeInternal: args.allWorkspaces,
  });

  const loaded = loadSession(ref);
  const report = analyze(ref, loaded.records, { topN: args.top });

  report.decode = {
    compressed: loaded.decoded.compressed,
    frames: loaded.decoded.frames,
    skippedFrames: loaded.decoded.skipped,
    chars: loaded.decoded.bytes.length,
    badLines: loaded.badLines,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      renderReport(report, { color: args.color, ascii: args.ascii, width: args.width }),
    );
  }

  if (args.failIfOver !== undefined) {
    const pct = report.current.percent;
    if (pct == null) {
      process.stderr.write('dsh-ctx: 没有可用的 contextWindow，无法判断阈值\n');
      return EXIT.failure;
    }
    if (pct > args.failIfOver) {
      process.stderr.write(
        `dsh-ctx: 上下文占用 ${formatPercent(pct)} (${formatTokens(report.current.tokens)}) 超过阈值 ` +
          `${args.failIfOver}% —— 该压缩了\n`,
      );
      return EXIT.threshold;
    }
  }

  return EXIT.ok;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`dsh-ctx: ${err.message}\n用 --help 查看用法。\n`);
    return EXIT.usage;
  }

  if (args.help) {
    process.stdout.write(HELP + '\n');
    return EXIT.ok;
  }
  if (args.version) {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return EXIT.ok;
  }

  try {
    return run(args);
  } catch (err) {
    process.stderr.write(`dsh-ctx: ${err.message}\n`);
    if (err.code === 'EUSAGE') {
      process.stderr.write('用 --help 查看用法。\n');
      return EXIT.usage;
    }
    if (err.code === 'ENO_SESSION' || err.code === 'ENO_SESSION_ROOT' || err.code === 'AMBIGUOUS') {
      return EXIT.usage;
    }
    if (args && args.json === false && process.env.DSH_CTX_DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
    return EXIT.failure;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, parseArgs, run, HELP, EXIT, formatCompact, path };
