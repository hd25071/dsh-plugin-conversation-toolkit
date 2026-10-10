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
import { codeSpan, escapeHtml, renderTranscript, splitContent, titleFromEvents } from '../lib/transcript.js';
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

test('the default export is the standard mode: the dialogue plus tool names', () => {
  const markdown = renderTranscript({ header: HEADER, events: EVENTS, title: 'A test conversation' });
  assert.match(markdown, /^# A test conversation$/m);
  assert.match(markdown, /### User\n\nFirst question/);
  assert.match(markdown, /### Assistant\n\nFirst answer/);
  assert.match(markdown, /Second answer/);
  // Turn sections, in order.
  assert.match(markdown, /^## Turn 1$/m);
  assert.match(markdown, /^## Turn 2$/m);
  assert.ok(markdown.indexOf('## Turn 1') < markdown.indexOf('## Turn 2'));
  assert.match(markdown, /- \*\*Turns\*\*: 2/);
  assert.match(markdown, /- \*\*Export\*\*: standard/);
  assert.match(markdown, /`session-test-0001`/);
  assert.ok(markdown.endsWith('\n'));
  assert.ok(!markdown.endsWith('\n\n'));

  // The tools are named, once per turn, without their payloads.
  assert.match(markdown, /\*\*Tools used\*\*: `read`/);

  // None of the material that makes an export leaky is present.
  assert.doesNotMatch(markdown, /Let me think about it\./);
  assert.doesNotMatch(markdown, /I should read the file\./);
  assert.doesNotMatch(markdown, /file_path/);
  assert.doesNotMatch(markdown, /file body/);
  assert.doesNotMatch(markdown, /<details>/);
});

test('the brief mode is the dialogue alone', () => {
  const markdown = renderTranscript({ header: HEADER, events: EVENTS, title: 'A test conversation', options: { mode: 'brief' } });
  assert.match(markdown, /First question/);
  assert.match(markdown, /First answer/);
  assert.doesNotMatch(markdown, /Let me think about it\./);
  assert.doesNotMatch(markdown, /Tools used/);
  assert.doesNotMatch(markdown, /file body/);
});

test('the full mode carries everything and warns about it', () => {
  const markdown = renderTranscript({ header: HEADER, events: EVENTS, title: 'A test conversation', options: { mode: 'full' } });
  assert.match(markdown, /Let me think about it\./);
  assert.match(markdown, /I should read the file\./);
  assert.match(markdown, /Tool call · <code>read<\/code>/);
  assert.match(markdown, /"file_path": "a\.txt"/);
  assert.match(markdown, /file body/);
  assert.match(markdown, /- \*\*Export\*\*: full/);
  // The warning is part of the document, not just the UI.
  assert.match(markdown, /\[!WARNING\]/);
  assert.match(markdown, /tool-call arguments and tool results/);
});

test('each mode is a superset of the narrower one', () => {
  const brief = renderTranscript({ header: HEADER, events: EVENTS, options: { mode: 'brief' } });
  const standard = renderTranscript({ header: HEADER, events: EVENTS, options: { mode: 'standard' } });
  const full = renderTranscript({ header: HEADER, events: EVENTS, options: { mode: 'full' } });
  assert.ok(brief.length < standard.length, 'standard adds the tool names');
  assert.ok(standard.length < full.length, 'full adds reasoning, arguments and results');
});

test('an unrecognised mode falls back to the narrow default, never to full', () => {
  const markdown = renderTranscript({ header: HEADER, events: EVENTS, options: { mode: 'everything-please' } });
  assert.match(markdown, /- \*\*Export\*\*: standard/);
  assert.doesNotMatch(markdown, /Let me think about it\./);
});

test('the legacy reasoning/tools switches still select a mode', () => {
  const compact = renderTranscript({ header: HEADER, events: EVENTS, options: { reasoning: false, tools: false } });
  assert.match(compact, /First question/);
  assert.doesNotMatch(compact, /Tools used/);
  assert.doesNotMatch(compact, /Let me think about it\./);

  const whole = renderTranscript({ header: HEADER, events: EVENTS, options: { reasoning: true, tools: true } });
  assert.match(whole, /Let me think about it\./);
  assert.match(whole, /file body/);
});

test('a hostile tool name cannot inject markup into the document', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, name: hostile, arguments: '{}' } }
  ];

  const full = renderTranscript({ header: HEADER, events, options: { mode: 'full' } });
  // Inside raw HTML the name must be escaped, and the payload must not be live markup.
  assert.match(full, /<code>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/code>/);
  assert.doesNotMatch(full, /<img src=x/);

  const standard = renderTranscript({ header: HEADER, events, options: { mode: 'standard' } });
  // Inside a code span entities are literal, so the name is kept verbatim instead.
  assert.ok(standard.includes(`\`${hostile}\``), 'the name survives verbatim in a code span');
});

test('a backtick in a tool name cannot close its code span', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, name: 'a`b', arguments: '{}' } }
  ];
  const markdown = renderTranscript({ header: HEADER, events, options: { mode: 'standard' } });
  const line = markdown.split('\n').find((value) => value.startsWith('**Tools used**'));
  assert.equal(line, "**Tools used**: `a'b`");
  assert.equal(codeSpan('a`b'), "`a'b`");
});

test('escapeHtml covers the characters that matter', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
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

/**
 * The prefix a `session.fork` at `cutSeq` would keep, which is what every
 * edit/regenerate/delete action actually produces.
 *
 * @param events - the stored log.
 * @param cutSeq - the inclusive cut.
 * @returns the kept events.
 */
function forkPrefix(events, cutSeq) {
  return events.filter((event) => event.seq <= cutSeq);
}

test('a real stored Session log folds and branches correctly', (t) => {
  const file = findSessionLog((header, log) => header.origin !== 'subagent' && log.events.length > 40);
  if (file === undefined) {
    t.skip('no stored DSH Session log on this machine');
    return;
  }
  const { header, events } = readSessionLog(file);
  const turns = analyzeTurns(events);
  const standard = renderTranscript({ header, events, title: titleFromEvents(events) });
  const full = renderTranscript({ header, events, title: titleFromEvents(events), options: { mode: 'full' } });
  const brief = renderTranscript({ header, events, title: titleFromEvents(events), options: { mode: 'brief' } });

  assert.ok(events.length > 0, 'the log has events');
  assert.ok(turns.length > 0, 'the log has turns');
  assert.ok(standard.length > 0, 'the transcript renders');
  assert.match(standard, /^# /);

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

  // Every mode renders one heading per folded turn and stays ordered.
  for (const markdown of [brief, standard, full]) {
    const headings = markdown.match(/^## Turn \d+$/gm) ?? [];
    assert.equal(headings.length, turns.length, 'one heading per folded turn');
  }
  assert.ok(brief.length < standard.length, 'standard adds the tool names');
  assert.ok(standard.length < full.length, 'full adds reasoning, arguments and results');
  assert.ok(full.length > 200, `the full transcript is substantial (${String(full.length)} chars)`);

  // The narrow modes must not carry the leaky payloads.
  for (const markdown of [brief, standard]) {
    assert.doesNotMatch(markdown, /<details><summary>Tool call/, 'no tool-call payloads outside full');
    assert.doesNotMatch(markdown, /<details><summary>Tool result/, 'no tool results outside full');
  }

  // ── branching ─────────────────────────────────────────────────────────
  // Every action is a fork at an inclusive cut, so the kept prefix must be a
  // clean boundary: no half turn, and no duplicated user message.
  for (const turn of turns) {
    if (turn.cutSeq === null) continue;
    const kept = forkPrefix(events, turn.cutSeq);
    const keptTurns = analyzeTurns(kept);
    const keptUserSeqs = kept.filter((event) => event.type === 'user/message').map((event) => event.seq);

    assert.equal(new Set(keptUserSeqs).size, keptUserSeqs.length, 'no duplicated user message after the cut');

    // Editing or deleting this turn must remove the turn itself and everything
    // after it: the prefix may not contain any of this turn's events.
    if (turn.startSeq !== null && turn.startSeq > turn.cutSeq) {
      assert.ok(!kept.some((event) => event.seq >= turn.startSeq), `cut ${String(turn.cutSeq)} drops turn ${String(turn.turn)}`);
    }

    // The prefix must end on a settled boundary, never mid-turn, so the child
    // does not resume a half-written step.
    if (kept.length > 0) {
      const last = kept.at(-1);
      assert.ok(
        ['turn/end', 'step/end', 'session/title', 'sandbox/mode', 'user/message'].includes(last.type) ||
          keptTurns.every((entry) => entry.endSeq !== null || entry.startSeq > last.seq),
        `the prefix ends on a boundary (${String(last.type)})`
      );
    }
  }

  // Regenerating a turn keeps its user message and drops the reply: the prefix
  // ends exactly at the user message, with no assistant step for that turn.
  for (const turn of turns) {
    if (turn.dropSeq === null || turn.dropSeq === undefined) continue;
    const kept = forkPrefix(events, turn.dropSeq);
    const last = kept.at(-1);
    assert.equal(last.seq, turn.dropSeq, 'the regenerate cut keeps the user message');
    assert.equal(last.type, 'user/message', 'and stops there');
    const after = kept.filter((event) => event.seq > turn.dropSeq);
    assert.equal(after.length, 0, 'nothing after the user message survives');
    assert.ok(
      !kept.some((event) => event.type === 'assistant/message' && event.seq > turn.dropSeq),
      'the reply being regenerated is dropped'
    );
  }
});
