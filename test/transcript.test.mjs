/**
 * Transcript and Turn-index tests.
 *
 * The fixtures are synthetic logs shaped exactly like stored DSH events, plus —
 * when a real Harness home is present — one end-to-end pass over the largest
 * installed `session.v4.jsonl.zstd`, so the folding code is exercised against
 * real model output instead of only against the sample below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeTurns, turnAtSeq, renderTurn } from '../lib/turns.js';
import { renderTranscript, splitContent, titleFromEvents } from '../lib/transcript.js';
import { findSessionLog, readSessionLog } from './helpers/session-log.mjs';

/** One two-turn conversation with reasoning and a tool call. */
const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-test-0001',
  createdAt: 1_700_000_000_000,
  cwd: 'D:\\work',
  isSeeded: false,
  agentPreset: 'standard'
};

const EVENTS = [
  { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
  { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 3, time: 4, data: { id: 'u1', content: [{ type: 'text', text: 'First question' }] } },
  {
    type: 'assistant/message',
    seq: 4,
    time: 5,
    data: {
      turn: 1,
      step: 1,
      model: 'deepseek-v4.1-flash',
      content: [
        { type: 'reasoning', text: 'Let me think about it.' },
        { type: 'text', text: 'First answer' }
      ]
    }
  },
  { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, kind: 'completed' } },
  { type: 'turn/start', seq: 7, time: 8, data: { turn: 2 } },
  { type: 'step/start', seq: 8, time: 9, data: { turn: 2, step: 1 } },
  { type: 'user/message', seq: 9, time: 10, data: { id: 'u2', content: [{ type: 'text', text: 'Second question' }] } },
  { type: 'tool/call', seq: 10, time: 11, data: { turn: 2, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
  {
    type: 'tool/result',
    seq: 11,
    time: 12,
    data: { turn: 2, step: 1, callId: 'c1', message: { content: [{ type: 'text', text: 'file body' }] } }
  },
  {
    type: 'assistant/message',
    seq: 12,
    time: 13,
    data: {
      turn: 2,
      step: 1,
      model: 'deepseek-v4.1-flash',
      content: [
        { type: 'reasoning', text: 'I should read the file.' },
        { type: 'text', text: 'Second answer' }
      ]
    }
  },
  { type: 'turn/end', seq: 13, time: 14, data: { turn: 2, kind: 'completed' } },
  { type: 'session/title', seq: 14, time: 15, data: { title: 'A test conversation', kind: 'fallback' } }
];

test('splitContent separates text from reasoning and reports other kinds', () => {
  const split = splitContent([
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'say' },
    { type: 'image', attachment: { attachmentId: 'x' } }
  ]);
  assert.equal(split.reasoning, 'think');
  assert.equal(split.text, 'say');
  assert.deepEqual(split.other, ['image']);
});

test('titleFromEvents folds the most recent title', () => {
  assert.equal(titleFromEvents(EVENTS), 'A test conversation');
  assert.equal(titleFromEvents([]), undefined);
});

test('renderTranscript hides reasoning and tools by default', () => {
  const markdown = renderTranscript({ header: HEADER, events: EVENTS, title: 'A test conversation' });
  assert.match(markdown, /^# A test conversation$/m);
  assert.match(markdown, /## User\n\nFirst question/);
  assert.match(markdown, /## Assistant\n\nFirst answer/);
  assert.match(markdown, /Second answer/);
  assert.doesNotMatch(markdown, /Let me think about it\./);
  assert.doesNotMatch(markdown, /file body/);
  assert.match(markdown, /`session-test-0001`/);
  assert.ok(markdown.endsWith('\n'));
  assert.ok(!markdown.endsWith('\n\n'));
});

test('renderTranscript includes reasoning and tools on request', () => {
  const markdown = renderTranscript({
    header: HEADER,
    events: EVENTS,
    title: 'A test conversation',
    options: { reasoning: true, tools: true }
  });
  assert.match(markdown, /<summary>Thinking<\/summary>/);
  assert.match(markdown, /Let me think about it\./);
  assert.match(markdown, /Tool call · `read`/);
  assert.match(markdown, /file body/);
});

test('analyzeTurns reports both turns with their cut points', () => {
  const turns = analyzeTurns(EVENTS);
  assert.equal(turns.length, 2);

  const [first, second] = turns;
  assert.equal(first.turn, 1);
  assert.equal(first.startSeq, 1);
  assert.equal(first.endSeq, 6);
  assert.equal(first.cutSeq, 0);
  assert.equal(first.user.text, 'First question');
  assert.equal(first.user.seq, 3);
  assert.equal(first.assistant.text, 'First answer');
  assert.equal(first.assistant.reasoning, 'Let me think about it.');

  assert.equal(second.turn, 2);
  assert.equal(second.startSeq, 7);
  assert.equal(second.endSeq, 13);
  assert.equal(second.cutSeq, 6);
  assert.equal(second.dropSeq, 9);
  assert.equal(second.assistant.toolCalls, 1);
});

test('turnAtSeq locates a turn from any event inside it', () => {
  const turns = analyzeTurns(EVENTS);
  assert.equal(turnAtSeq(turns, 3).turn, 1);
  assert.equal(turnAtSeq(turns, 6).turn, 1);
  assert.equal(turnAtSeq(turns, 9).turn, 2);
  assert.equal(turnAtSeq(turns, 13).turn, 2);
  assert.equal(turnAtSeq(turns, 99), undefined);
});

test('cutSeq of a turn is an inclusive prefix of everything before it', () => {
  const turns = analyzeTurns(EVENTS);
  const second = turns[1];
  const kept = EVENTS.filter((event) => event.seq <= second.cutSeq);
  assert.equal(kept.at(-1).seq, 6);
  assert.equal(kept.at(-1).type, 'turn/end');
  assert.ok(!kept.some((event) => event.data?.turn === 2));
});

test('renderTurn renders one turn as a Markdown fragment', () => {
  const turns = analyzeTurns(EVENTS);
  const markdown = renderTurn(turns[1]);
  assert.match(markdown, /^### Turn 2 · User$/m);
  assert.match(markdown, /Second question/);
  assert.match(markdown, /### Assistant/);
  assert.match(markdown, /Second answer/);
  assert.doesNotMatch(markdown, /I should read the file\./);
});

test('analyzeTurns tolerates an open final turn and unknown events', () => {
  const events = [
    ...EVENTS,
    { type: 'turn/start', seq: 15, time: 16, data: { turn: 3 } },
    { type: 'some/future-event', seq: 16, time: 17, data: { anything: true } },
    { type: 'user/message', seq: 17, time: 18, data: { id: 'u3', content: [{ type: 'text', text: 'Third question' }] } }
  ];
  const turns = analyzeTurns(events);
  assert.equal(turns.length, 3);
  assert.equal(turns[2].endSeq, null);
  assert.equal(turns[2].user.text, 'Third question');
  assert.equal(turns[2].cutSeq, 14);
});

test('a real stored Session log folds without throwing', (t) => {
  const file = findSessionLog((header, log) => header.origin !== 'subagent' && log.events.length > 40);
  if (file === undefined) {
    t.skip('no stored DSH Session log on this machine');
    return;
  }
  const { header, events } = readSessionLog(file);
  const turns = analyzeTurns(events);
  const markdown = renderTranscript({ header, events, title: titleFromEvents(events) });

  assert.ok(events.length > 0, 'the log has events');
  assert.ok(turns.length > 0, 'the log has turns');
  assert.ok(markdown.length > 0, 'the transcript renders');
  assert.match(markdown, /^# /);

  for (const turn of turns) {
    assert.equal(typeof turn.turn, 'number');
    assert.equal(typeof turn.startSeq, 'number');
    if (turn.cutSeq !== null) {
      // The cut must address a real event, which is what `session.fork` requires.
      assert.ok(events.some((event) => event.seq === turn.cutSeq), `cut seq ${String(turn.cutSeq)} exists`);
    }
  }
  const withUser = turns.filter((turn) => turn.user !== null).length;
  assert.ok(withUser > 0, 'at least one turn carries user text');
});
