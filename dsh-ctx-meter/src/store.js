'use strict';

/**
 * Reading DeepSeek Harness session files.
 *
 * A session is stored as `session.v4.jsonl.zstd`: a raw concatenation of
 * independent zstd frames. Every frame holds one or more complete JSONL lines.
 * Node's `zstdDecompressSync` only decodes the *first* frame, and the zstd
 * stream API behaves the same way, so a session must be decoded frame by frame.
 *
 * The trick used here: every frame starts with the 4-byte zstd magic number, and
 * feeding `zstdDecompressSync(buf.subarray(pos))` decodes exactly the frame that
 * begins at `pos` while ignoring everything after it. So scanning for magic
 * numbers and decoding from each hit recovers every frame, without needing to
 * know frame byte lengths (which zstd does not expose to Node).
 *
 * Decoded frames are concatenated as buffers and only then turned into text, so a
 * multi-byte character split across a frame boundary can never be corrupted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** Workspaces owned by background plugins rather than a human. */
const INTERNAL_WORKSPACE = /aik_auto_memory_use/i;

/** Warn instead of silently eating gigabytes when a session file is huge. */
const BIG_FILE_BYTES = 256 * 1024 * 1024;

/** @param {string} dir */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every place sessions may live, most explicit first.
 * @returns {{ root: string, source: string }[]}
 */
function sessionRootCandidates() {
  /** @type {{ root: string, source: string }[]} */
  const out = [];
  if (process.env.DSH_SESSIONS_DIR) {
    out.push({ root: path.resolve(process.env.DSH_SESSIONS_DIR), source: 'DSH_SESSIONS_DIR' });
  }
  // A profile usually owns its sessions, but a desktop install keeps them under
  // the shared ~/.dsh/sessions, so existence decides rather than order alone.
  if (process.env.DSH_PROFILE_DIR) {
    out.push({ root: path.join(process.env.DSH_PROFILE_DIR, 'sessions'), source: 'DSH_PROFILE_DIR' });
  }
  if (process.env.DSH_HOME) {
    out.push({ root: path.join(process.env.DSH_HOME, 'sessions'), source: 'DSH_HOME' });
  }
  out.push({ root: path.join(os.homedir(), '.dsh', 'sessions'), source: '~/.dsh/sessions' });
  return out;
}

/**
 * Where sessions live: the first candidate that exists, else the first candidate
 * so the error message can show what was tried.
 * @param {string} [explicitRoot]
 * @returns {{ root: string, source: string, tried: string[] }}
 */
function resolveSessionRoot(explicitRoot) {
  if (explicitRoot) {
    return { root: path.resolve(explicitRoot), source: '--root', tried: [path.resolve(explicitRoot)] };
  }
  const candidates = sessionRootCandidates();
  const found = candidates.find((c) => isDirectory(c.root));
  const chosen = found || candidates[0];
  return { root: chosen.root, source: chosen.source, tried: candidates.map((c) => `${c.root} (${c.source})`) };
}

/**
 * @typedef {object} SessionRef
 * @property {string} id          session id (directory name, `session-` stripped)
 * @property {string} file        absolute path to session.v4.jsonl.zstd
 * @property {string} workspace   escaped workspace directory name (lossy, display only)
 * @property {number} size        compressed bytes
 * @property {number} mtimeMs     last write time
 * @property {boolean} internal   belongs to a plugin-owned workspace
 */

/**
 * List every session file under a root, newest first.
 * @param {string} root
 * @returns {SessionRef[]}
 */
function listSessions(root) {
  /** @type {SessionRef[]} */
  const out = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const e = new Error(`cannot read session root: ${root} (${err.code || err.message})`);
    e.code = 'ENO_SESSION_ROOT';
    throw e;
  }

  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let entries;
    try {
      entries = fs.readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(wsDir, entry.name, SESSION_FILE);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({
        id: entry.name.replace(/^session-/, ''),
        file,
        workspace: ws.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        internal: INTERNAL_WORKSPACE.test(ws.name),
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Find a session by full id, id prefix, file path, or (default) the newest one.
 * @param {{ root: string, sessions?: SessionRef[], query?: string, includeInternal?: boolean }} opts
 * @returns {SessionRef}
 */
function pickSession(opts) {
  const sessions = opts.sessions || listSessions(opts.root);
  if (sessions.length === 0) {
    const e = new Error(`no session files found under ${opts.root}`);
    e.code = 'ENO_SESSION';
    throw e;
  }

  const query = opts.query;
  if (query) {
    const asPath = path.resolve(query);
    if (/[\\/]/.test(query) || fs.existsSync(asPath)) {
      const direct = sessions.find(
        (s) => path.resolve(s.file) === asPath || path.resolve(path.dirname(s.file)) === asPath,
      );
      if (direct) return direct;
      const e = new Error(`no session file at ${asPath}`);
      e.code = 'ENO_SESSION';
      throw e;
    }
    const needle = query.toLowerCase();
    const matches = sessions.filter((s) => s.id.toLowerCase().startsWith(needle));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const e = new Error(
        `session id prefix "${query}" is ambiguous (${matches.length} matches):\n` +
          matches.map((s) => `  ${s.id}`).join('\n'),
      );
      e.code = 'AMBIGUOUS';
      throw e;
    }
    const anywhere = sessions.filter((s) => s.id.toLowerCase().includes(needle));
    if (anywhere.length === 1) return anywhere[0];
    const e = new Error(`no session matches "${query}"`);
    e.code = 'ENO_SESSION';
    throw e;
  }

  const candidates = opts.includeInternal ? sessions : sessions.filter((s) => !s.internal);
  return candidates[0] || sessions[0];
}

/**
 * @typedef {object} DecodeResult
 * @property {Buffer} bytes        decoded payload
 * @property {number} frames       frames successfully decoded
 * @property {number} candidates   magic-number candidates inspected
 * @property {number} skipped      candidates that did not decode as a frame
 * @property {number} compressed   compressed size on disk
 */

/**
 * Decode every zstd frame in a session file.
 * @param {string} file
 * @returns {DecodeResult}
 */
function decodeSessionFile(file) {
  const compressed = fs.readFileSync(file);
  if (compressed.length === 0) {
    return { bytes: Buffer.alloc(0), frames: 0, candidates: 0, skipped: 0, compressed: 0 };
  }
  if (!compressed.subarray(0, 4).equals(ZSTD_MAGIC)) {
    const e = new Error(`${file} does not start with a zstd frame`);
    e.code = 'ENOT_ZSTD';
    throw e;
  }

  /** @type {Buffer[]} */
  const parts = [];
  let candidates = 0;
  let skipped = 0;
  let pos = 0;
  // Only positions found by the magic scan are tried; advancing past the whole
  // remaining buffer is unnecessary because decoding from `pos` stops at the end
  // of that frame anyway.
  while (pos <= compressed.length - 4) {
    const hit = compressed.indexOf(ZSTD_MAGIC, pos);
    if (hit < 0) break;
    candidates += 1;
    try {
      parts.push(zlib.zstdDecompressSync(compressed.subarray(hit)));
    } catch {
      skipped += 1;
    }
    pos = hit + 4;
  }

  return {
    bytes: parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts),
    frames: parts.length,
    candidates,
    skipped,
    compressed: compressed.length,
  };
}

/**
 * @typedef {object} ParsedSession
 * @property {Record<string, any>[]} records     successfully parsed records
 * @property {number} badLines                   lines that failed to parse
 */

/**
 * Parse decoded JSONL text into records.
 * @param {Buffer|string} bytes
 * @returns {ParsedSession}
 */
function parseRecords(bytes) {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  /** @type {Record<string, any>[]} */
  const records = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line || !line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines };
}

/**
 * Read, decode and parse a session in one step.
 * @param {SessionRef} ref
 */
function loadSession(ref) {
  if (ref.size > BIG_FILE_BYTES) {
    process.stderr.write(
      `warning: ${ref.file} is ${(ref.size / 1048576).toFixed(0)} MB compressed; decoding may take a while\n`,
    );
  }
  const decoded = decodeSessionFile(ref.file);
  const parsed = parseRecords(decoded.bytes);
  return { ref, decoded, records: parsed.records, badLines: parsed.badLines };
}

module.exports = {
  ZSTD_MAGIC,
  SESSION_FILE,
  resolveSessionRoot,
  listSessions,
  pickSession,
  decodeSessionFile,
  parseRecords,
  loadSession,
};
