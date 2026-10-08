/**
 * Test helper: read a DSH `session.v4.jsonl.zstd` log.
 *
 * The JSONL backend appends one zstd frame per flushed batch, so a stored log is
 * a *concatenation* of frames rather than one stream. `zstdDecompressSync` stops
 * after the first frame, which silently yields only the Session header; this
 * helper splits on the zstd magic number and decodes every frame.
 *
 * @module test/helpers/session-log
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

/** Little-endian zstd frame magic (`0xFD2FB528`). */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress a concatenated-frame zstd buffer.
 *
 * @param buffer - the raw file bytes.
 * @returns the decoded UTF-8 text.
 */
export function decompressFrames(buffer) {
  const offsets = [];
  let index = 0;
  for (;;) {
    const found = buffer.indexOf(MAGIC, index);
    if (found === -1) break;
    offsets.push(found);
    index = found + 1;
  }
  if (offsets.length === 0) return zlib.zstdDecompressSync(buffer).toString('utf8');
  const parts = [];
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame];
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'));
    } catch {
      // A torn tail is expected after a crash; readers never see it either.
    }
  }
  return parts.join('');
}

/**
 * Parse one stored Session log into its header and events.
 *
 * @param file - absolute path to a `session.v4.jsonl.zstd` file.
 * @returns the header line and the parsed event list.
 */
export function readSessionLog(file) {
  const text = decompressFrames(fs.readFileSync(file));
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  let header;
  const events = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === 'session') header = parsed;
    else events.push(parsed);
  }
  return { header, events };
}

/**
 * Find a real stored Session log to test against.
 *
 * @param predicate - optional filter over the header.
 * @returns the file path, or `undefined` when no log is installed.
 */
export function findSessionLog(predicate = () => true) {
  const root = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const sessions = path.join(root, 'sessions');
  if (!fs.existsSync(sessions)) return undefined;
  const candidates = [];
  for (const workspace of fs.readdirSync(sessions)) {
    const dir = path.join(sessions, workspace);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const session of fs.readdirSync(dir)) {
      const file = path.join(dir, session, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      candidates.push({ file, size: fs.statSync(file).size });
    }
  }
  candidates.sort((left, right) => right.size - left.size);
  for (const candidate of candidates) {
    try {
      const log = readSessionLog(candidate.file);
      if (log.header !== undefined && predicate(log.header, log)) return candidate.file;
    } catch {
      continue;
    }
  }
  return undefined;
}
