/**
 * Pure Turn indexing over a stored Session event log.
 *
 * The Harness persists a conversation as an append-only event log; a *Turn* is
 * the window between a `turn/start` and its matching `turn/end`. This module
 * folds that window into exactly the facts a rewrite action needs — who spoke,
 * what they said, and the inclusive sequence number to cut at.
 *
 * Why a cut index rather than an edit API: DSH persistence is append-only and
 * its events are never rewritten, so the only transcript transformation the
 * platform offers is `session.fork({ sessionId, atSeq })`, where `atSeq` is an
 * **inclusive** cut. "Edit and resend", "delete this turn and everything after"
 * and "regenerate" are therefore all the same operation with a different cut
 * point, and this module computes those points.
 *
 * @module dsh-plugin-conversation-toolkit/turns
 */

import { splitContent } from './transcript.js';

/**
 * Describe one Turn.
 *
 * @typedef {object} TurnRecord
 * @property {number} turn - the Harness turn number.
 * @property {number} startSeq - `seq` of the `turn/start` event.
 * @property {number|null} endSeq - `seq` of the matching `turn/end`, or `null` while open.
 * @property {number|null} cutSeq - inclusive `atSeq` that keeps everything *before* this turn.
 * @property {number|null} dropSeq - inclusive `atSeq` that keeps this turn's user message only.
 * @property {{seq: number, text: string, time: number|null}|null} user - the turn's user input.
 * @property {{text: string, reasoning: string, toolCalls: number}} assistant - the turn's output.
 * @property {number|null} time - the turn's first event time.
 */

/**
 * Index every Turn in one stored event log.
 *
 * Unknown event types are ignored, and a log whose final turn never closed is
 * still reported (with `endSeq: null`) so the UI can show it as running.
 *
 * @param events - the replay-validated event log, ascending by `seq`.
 * @returns the Turn records in log order.
 */
export function analyzeTurns(events) {
  const list = Array.isArray(events) ? events : [];
  /** @type {Map<number, TurnRecord & {parts: {text: string[], reasoning: string[]}}>} */
  const byTurn = new Map();
  const order = [];

  const openTurn = (turn, event) => {
    let record = byTurn.get(turn);
    if (record === undefined) {
      record = {
        turn,
        startSeq: typeof event.seq === 'number' ? event.seq : 0,
        endSeq: null,
        cutSeq: null,
        dropSeq: null,
        user: null,
        assistant: { text: '', reasoning: '', toolCalls: 0 },
        time: typeof event.time === 'number' ? event.time : null,
        parts: { text: [], reasoning: [] }
      };
      byTurn.set(turn, record);
      order.push(record);
    }
    return record;
  };

  /**
   * The turn currently open, tracked from `turn/start`.
   *
   * Stored `user/message` events carry no `turn` field — only the turn and step
   * envelopes do — so a user message belongs to the most recently started turn.
   */
  let currentTurn;
  /**
   * A user message seen before any `turn/start`.
   *
   * A seeded or forked prefix can open with the message itself, in which case it
   * belongs to whichever turn starts next.
   */
  let pendingUser;

  const attachUser = (record, seq, text, time) => {
    if (record.user === null && text.trim() !== '') {
      record.user = { seq, text, time };
      record.dropSeq = seq;
    }
  };

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue;
    const data = event.data ?? {};
    const seq = typeof event.seq === 'number' ? event.seq : null;
    if (seq === null) continue;
    const time = typeof event.time === 'number' ? event.time : null;
    if (typeof data.turn === 'number') currentTurn = data.turn;

    switch (event.type) {
      case 'turn/start': {
        if (typeof data.turn !== 'number') break;
        const record = openTurn(data.turn, event);
        record.startSeq = seq;
        record.cutSeq = seq > 0 ? seq - 1 : null;
        if (pendingUser !== undefined) {
          attachUser(record, pendingUser.seq, pendingUser.text, pendingUser.time);
          pendingUser = undefined;
        }
        break;
      }
      case 'turn/end': {
        if (typeof data.turn !== 'number') break;
        openTurn(data.turn, event).endSeq = seq;
        break;
      }
      case 'user/message': {
        const { text } = splitContent(data.content);
        if (typeof data.turn !== 'number' && currentTurn === undefined) {
          if (pendingUser === undefined) pendingUser = { seq, text, time };
          break;
        }
        const turn = typeof data.turn === 'number' ? data.turn : currentTurn;
        attachUser(openTurn(turn, event), seq, text, time);
        break;
      }
      case 'assistant/message': {
        if (typeof data.turn !== 'number' && currentTurn === undefined) break;
        const record = openTurn(typeof data.turn === 'number' ? data.turn : currentTurn, event);
        const content = splitContent(data.content);
        const blocks = splitContent(data.blocks);
        const text = content.text.trim() !== '' ? content.text : blocks.text;
        const reasoning = content.reasoning.trim() !== '' ? content.reasoning : blocks.reasoning;
        if (text.trim() !== '') record.parts.text.push(text);
        if (reasoning.trim() !== '') record.parts.reasoning.push(reasoning);
        break;
      }
      case 'tool/call': {
        if (typeof data.turn !== 'number' && currentTurn === undefined) break;
        openTurn(typeof data.turn === 'number' ? data.turn : currentTurn, event).assistant.toolCalls += 1;
        break;
      }
      default:
        break;
    }
  }

  return order.map((record) => ({
    turn: record.turn,
    startSeq: record.startSeq,
    endSeq: record.endSeq,
    cutSeq: record.cutSeq,
    dropSeq: record.dropSeq,
    user: record.user,
    assistant: {
      text: record.parts.text.join('\n\n').trim(),
      reasoning: record.parts.reasoning.join('\n\n').trim(),
      toolCalls: record.assistant.toolCalls
    },
    time: record.time
  }));
}

/**
 * Find the Turn that owns one sequence number.
 *
 * `seq` may be any event inside the turn (the closing `turn/end`, a `user/message`,
 * or a tool call), so callers that hold only a chat anchor still resolve a turn.
 *
 * @param turns - records from {@link analyzeTurns}.
 * @param seq - the event sequence to locate.
 * @returns the owning record, or `undefined`.
 */
export function turnAtSeq(turns, seq) {
  if (!Array.isArray(turns) || typeof seq !== 'number') return undefined;
  return turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === null || seq <= turn.endSeq));
}

/**
 * Render one Turn as a standalone Markdown fragment.
 *
 * @param turn - one record from {@link analyzeTurns}.
 * @param options - render switches.
 * @param options.reasoning - include the turn's reasoning (default `false`).
 * @returns the Markdown fragment.
 */
export function renderTurn(turn, options = {}) {
  const out = [];
  const title = turn.user === null || turn.user.text.trim() === '' ? `Turn ${turn.turn}` : `Turn ${turn.turn} · User`;
  out.push(`### ${title}`, '');
  if (turn.user !== null && turn.user.text.trim() !== '') out.push(turn.user.text, '');
  if (options.reasoning === true && turn.assistant.reasoning.trim() !== '') {
    out.push('<details><summary>Thinking</summary>', '', turn.assistant.reasoning, '', '</details>', '');
  }
  if (turn.assistant.text.trim() !== '') out.push('### Assistant', '', turn.assistant.text, '');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}
