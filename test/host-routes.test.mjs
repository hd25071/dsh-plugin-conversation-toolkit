/**
 * Host-half route tests.
 *
 * The Host half never imports a Harness package, so it can be driven directly:
 * a Cordis-shaped context records the Fetch routes it registers, and a stand-in
 * `sessionQuery` serves a fixture log. These tests pin the wire contract the
 * Client half depends on — route paths, methods, query parameters, status codes,
 * and the JSON envelope — because a mismatch there is silent at load time and
 * only shows up as a failed copy in the browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name, TRANSCRIPT_PATH, TURNS_PATH } from '../lib/index.js';

/** A minimal two-turn log. */
const EVENTS = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { id: 'u1', content: [{ type: 'text', text: 'Hello' }] } },
  {
    type: 'assistant/message',
    seq: 2,
    time: 3,
    data: { turn: 1, content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Hi there' }] }
  },
  { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, kind: 'completed' } },
  { type: 'session/title', seq: 4, time: 5, data: { title: 'Greeting' } }
];

const HEADER = { type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'D:\\x' };

/**
 * Build a context whose connection service records routes.
 *
 * The object is a Proxy that reproduces Cordis's resolution rule: a property
 * that is not an own member throws `cannot get property "…" without inject`.
 * A sibling-provided service is therefore reachable ONLY through `ctx.get`,
 * which is what the plugin must use — if the code regresses to plain property
 * access, these tests fail with a 503 instead of silently passing.
 *
 * @param options - test seams.
 * @param options.sessionQuery - the query service, or `undefined` to simulate a profile without one.
 * @returns the context, the registered routes, and a caller.
 */
function fakeContext(options = {}) {
  const routes = new Map();
  const base = {
    get(name) {
      if (name === 'sessionQuery') return options.sessionQuery;
      return undefined;
    },
    connection: {
      fetch: {
        register(route) {
          assert.ok(!routes.has(route.path), `route ${route.path} registered once`);
          routes.set(route.path, route);
        }
      }
    }
  };
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    }
  });
  return {
    ctx,
    routes,
    /**
     * Dispatch one synthetic request.
     *
     * @param path - the absolute route path.
     * @param query - query parameters.
     * @param method - HTTP method.
     * @returns the response.
     */
    call(path, query = '', method = 'GET') {
      const route = routes.get(path);
      assert.ok(route !== undefined, `route ${path} is registered`);
      assert.ok(route.methods.includes(method), `${path} accepts ${method}`);
      return route.fetch(new Request(`http://127.0.0.1:19387${path}${query === '' ? '' : `?${query}`}`, { method }));
    }
  };
}

/**
 * Build a stand-in session-query service.
 *
 * @param options - test seams.
 * @returns the service.
 */
function fakeQuery(options = {}) {
  return {
    async readSession(sessionId) {
      if (options.missing === true || sessionId !== 'session-x') {
        const error = new Error(`session "${sessionId}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      if (options.corrupt === true) throw new Error('log is unreadable');
      return { session: HEADER, inheritedEventCount: 0, events: structuredClone(EVENTS) };
    }
  };
}

test('the host half declares its plugin face', () => {
  assert.equal(name, 'conversation-toolkit');
  assert.deepEqual(inject, ['connection']);
  assert.equal(typeof apply, 'function');
  assert.equal(TRANSCRIPT_PATH, '/api/conversation-toolkit/transcript');
  assert.equal(TURNS_PATH, '/api/conversation-toolkit/turns');
});

test('apply() registers both routes on /api with GET and HEAD', () => {
  const { ctx, routes } = fakeContext({ sessionQuery: fakeQuery() });
  apply(ctx);
  assert.deepEqual([...routes.keys()].sort(), [TURNS_PATH, TRANSCRIPT_PATH].sort());
  for (const route of routes.values()) {
    assert.deepEqual([...route.methods].sort(), ['GET', 'HEAD']);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
});

test('apply() stays inert without a connection service', () => {
  assert.doesNotThrow(() => apply({ get: () => undefined }));
});

test('the transcript route serves Markdown with its title header', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/markdown/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(decodeURIComponent(response.headers.get('x-conversation-toolkit-title')), 'Greeting');

  const markdown = await response.text();
  assert.match(markdown, /^# Greeting/);
  assert.match(markdown, /Hello/);
  assert.match(markdown, /Hi there/);
  // The default export is the narrow one: thinking is NOT included unless asked.
  assert.doesNotMatch(markdown, /hmm/);
  assert.match(markdown, /- \*\*Export\*\*: standard/);
  assert.match(markdown, /^## Turn 1$/m);
});

test('a sibling-provided service is reached through ctx.get, not property access', async () => {
  // `fakeContext` throws on unknown property access exactly as Cordis does, so
  // a 200 here proves the route used the documented reader.
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x');
  assert.equal(response.status, 200);
});

test('the transcript route honours the export mode', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);

  const full = await (await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x&mode=full')).text();
  assert.match(full, /hmm/);
  assert.match(full, /\[!WARNING\]/);

  const brief = await (await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x&mode=brief')).text();
  assert.match(brief, /Hi there/);
  assert.doesNotMatch(brief, /hmm/);

  // An unknown mode must land on the narrow default, never on full.
  const bogus = await (await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x&mode=nope')).text();
  assert.doesNotMatch(bogus, /hmm/);
  assert.match(bogus, /- \*\*Export\*\*: standard/);
});

test('the transcript route still accepts the legacy switches', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const markdown = await (await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x&reasoning=0&tools=0')).text();
  assert.match(markdown, /Hi there/);
  assert.doesNotMatch(markdown, /hmm/);
});

test('the transcript route can answer JSON for embedding', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const body = await (await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x&format=json')).json();
  assert.equal(body.ok, true);
  assert.equal(body.value.sessionId, 'session-x');
  assert.equal(body.value.title, 'Greeting');
  assert.equal(body.value.eventCount, EVENTS.length);
  assert.match(body.value.markdown, /^# Greeting/);
});

test('an unknown Session is a 404 business failure, not a crash', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-missing');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'session-not-found', message: 'session "session-missing" not found' }
  });
});

test('an unreadable log is a 500 business failure', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery({ corrupt: true }) });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'session-unreadable');
});

test('a missing sessionId is rejected before any read', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'bad-request');
});

test('a profile without sessionQuery answers 503 with a diagnosable code', async () => {
  const harness = fakeContext({ sessionQuery: undefined });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service-unavailable');
});

test('the turns route returns the cut points the Client forks at', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const body = await (await harness.call(TURNS_PATH, 'sessionId=session-x')).json();
  assert.equal(body.ok, true);
  assert.equal(body.value.title, 'Greeting');
  assert.equal(body.value.turns.length, 1);
  const [turn] = body.value.turns;
  assert.equal(turn.turn, 1);
  assert.equal(turn.startSeq, 0);
  assert.equal(turn.endSeq, 3);
  assert.equal(turn.cutSeq, null, 'the first turn has nothing to keep before it');
  assert.equal(turn.dropSeq, 1);
  assert.equal(turn.user.text, 'Hello');
  assert.equal(turn.assistant.text, 'Hi there');
  assert.equal(turn.assistant.reasoning, 'hmm');
});

test('HEAD answers with the same status and no body', async () => {
  const harness = fakeContext({ sessionQuery: fakeQuery() });
  apply(harness.ctx);
  const response = await harness.call(TRANSCRIPT_PATH, 'sessionId=session-x', 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});
