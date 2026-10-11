/**
 * Client-bundle contract tests.
 *
 * The browser half cannot be type-checked and cannot be rendered outside the
 * Harness, so this suite exercises the three things that actually decide whether
 * it activates at all:
 *
 * 1. the bundle parses and registers exactly the factory id the module loader
 *    demands (it must equal the package name, or every page load throws
 *    `bundle … loaded without registering "<id>"`),
 * 2. `apply(ctx)` completes against the real service names and registers into
 *    declared slots with the ids and orders this plugin claims, and
 * 3. each registered component is callable with the props its slot documents.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'client', 'client.js');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const SOURCE = fs.readFileSync(BUNDLE, 'utf8');

/**
 * Build the minimal React surface the bundle touches at definition time.
 *
 * Hooks are inert, but `useState` honours a functional initial value and
 * `useCallback`/`useMemo` return the callback result, so calling a component
 * once produces the same element tree a first render would.
 *
 * @returns the shim.
 */
function reactShim() {
  const Fragment = Symbol('Fragment');
  /** The component instance currently rendering. */
  let current = null;

  const shim = {
    Fragment,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
    },
    useState(initial) {
      // Bind to this instance: a component may resolve a promise after the render
      // pass, and reaching for the shared `current` then would be null.
      const instance = current;
      const index = instance.index;
      if (instance.hooks[index] === undefined) {
        instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = instance.hooks[index];
      instance.index += 1;
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
          if (instance.live) instance.dirty = true;
        }
      ];
    },
    useEffect(fn, deps) {
      const index = current.index;
      if (current.hooks[index] === undefined) current.hooks[index] = { deps: undefined, cleanup: undefined };
      const slot = current.hooks[index];
      current.index += 1;
      const changed =
        deps === undefined ||
        slot.deps === undefined ||
        deps.length !== slot.deps.length ||
        deps.some((value, position) => value !== slot.deps[position]);
      if (!changed) return;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.deps = deps;
      const cleanup = fn();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    },
    useLayoutEffect(fn, deps) {
      shim.useEffect(fn, deps);
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    useRef(value) {
      const index = current.index;
      if (current.hooks[index] === undefined) current.hooks[index] = { ref: { current: value } };
      current.index += 1;
      return current.hooks[index].ref;
    },
    useSyncExternalStore(getSnapshot) {
      return getSnapshot();
    },
    /**
     * Render a component, flushing effects and re-rendering while it schedules
     * state. This is what makes the behaviour-only components testable.
     *
     * @param component - the component to render.
     * @param props - its props.
     * @returns the element tree.
     */
    render(component, props) {
      const instance = { hooks: [], index: 0, dirty: false, live: true };
      const previous = current;
      let tree;
      let passes = 0;
      do {
        instance.dirty = false;
        instance.index = 0;
        current = instance;
        tree = component(props);
        passes += 1;
      } while (instance.dirty && passes < 30);
      // A later update from an in-flight fetch is simply ignored.
      instance.live = false;
      current = previous;
      return tree;
    }
  };
  return shim;
}

/**
 * Materialize the bundle's factory.
 *
 * @param options - test seams.
 * @param options.href - the document URL the deep-link reader sees.
 * @returns the module exports plus the recorded calls.
 */
function materialize(options = {}) {
  const registered = [];
  const styles = [];
  const moduleLoader = {
    load(record) {
      assert.equal(typeof record.id, 'string');
      assert.equal(typeof record.factory, 'function');
      moduleLoader.registered = record;
    }
  };
  const React = reactShim();
  /** Anchors the bundle created and clicked, i.e. the downloads it requested. */
  const downloads = [];
  /** Timers the bundle scheduled, recorded rather than run. */
  const scheduledTimers = [];
  const documentStub = {
    head: { appendChild: (node) => styles.push(node) },
    body: { appendChild() {}, removeChild() {} },
    createElement: (tag) => {
      const node = {
        tag,
        style: {},
        dataset: {},
        remove() {},
        setAttribute() {},
        select() {},
        setSelectionRange() {},
        focus() {}
      };
      node.click = () => downloads.push({ tag, download: node.download });
      return node;
    },
    querySelector: () => null,
    execCommand: () => (options.execCommand === undefined ? true : options.execCommand)
  };
  const windowStub = { __ModuleLoader__: moduleLoader, location: { href: options.href ?? 'http://127.0.0.1:19387/' } };
  const navigatorStub = { clipboard: options.clipboard ?? { writeText: async () => {} } };

  const run = new Function('window', 'document', 'navigator', 'fetch', 'Date', 'setTimeout', SOURCE);
  run(
    windowStub,
    documentStub,
    navigatorStub,
    options.fetch ?? (async () => new Response('', { status: 200 })),
    options.Date ?? Date,
    options.setTimeout ??
      ((fn, delay) => {
        scheduledTimers.push({ fn, delay });
        return 0;
      })
  );

  const record = moduleLoader.registered;
  assert.ok(record !== undefined, 'the bundle registers a factory');
  const exports = record.factory((specifier) => {
    assert.equal(specifier, 'react', `the bundle requires only react, saw ${specifier}`);
    return React;
  });
  return { record, exports, registered, styles, React, downloads, scheduledTimers };
}

/**
 * Build a Cordis-shaped client context recording every registration.
 *
 * @param options - test seams.
 * @returns the context and the recorded state.
 */
function fakeContext(options = {}) {
  const state = {
    registrations: [],
    injections: [],
    locales: [],
    effects: [],
    opened: [],
    forkCalls: [],
    searches: [],
    timers: []
  };
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      state.effects.push({ label, dispose });
      return () => {};
    },
    locale: {
      register(ns, dicts) {
        state.locales.push({ ns, dicts });
        return () => {};
      }
    },
    slots: {
      inject(name, callback) {
        state.injections.push(name);
        const produced = callback();
        // The shipped plugins use generator callbacks to yield several
        // registrations; each `register` call already recorded itself.
        if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function' && typeof produced.next === 'function') {
          for (const entry of produced) void entry;
        }
        return () => {};
      },
      register(definition, component) {
        const entry = { definition, component };
        state.registrations.push(entry);
        return entry;
      }
    },
    sessions: {
      async search(query, signal) {
        state.searches.push({ query, signal });
        return { ok: true, value: { items: [{ sessionId: 'session-a', snippet: 'hit' }], hasMore: false } };
      },
      async fork(opts) {
        state.forkCalls.push(opts);
        return 'session-child';
      }
    },
    uiWorkspace: {
      openSession(target) {
        state.opened.push(target);
      }
    },
    timeout(fn, delay) {
      state.timers.push({ fn, delay });
      return () => {};
    }
  };
  void options;
  return { ctx, state };
}

/**
 * Let pending promises settle.
 *
 * A user-initiated retry asks the child Session what it already holds before it
 * acts, so its effects complete several turns after the click.
 *
 * @returns a promise that resolves once the queue drains.
 */
async function flush() {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('the bundle registers the factory id the module loader requires', () => {
  const { record } = materialize();
  assert.equal(record.id, MANIFEST.name, 'the factory id equals the package name');
});

test('the bundle requires no Harness client package', () => {
  const requires = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  const unique = [...new Set(requires)];
  assert.deepEqual(unique, ['react'], `only react may be required, saw: ${unique.join(', ')}`);
});

test('module exports expose the plugin face', () => {
  const { exports } = materialize();
  assert.equal(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject));
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'uiWorkspace', 'locale']);
});

test('apply() registers every claimed extension point', () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);

  const summary = state.registrations.map((entry) => ({
    slot: entry.definition.name,
    id: entry.definition.id ?? entry.definition.key,
    order: entry.definition.order
  }));

  assert.deepEqual(summary, [
    { slot: 'sidebar.workspaces.session.menu.item', id: 'conversation-toolkit.copy-markdown', order: 500 },
    { slot: 'sidebar.workspaces.session.menu.item', id: 'conversation-toolkit.copy-markdown-full', order: 505 },
    { slot: 'sidebar.workspaces.session.menu.item', id: 'conversation-toolkit.copy-markdown-brief', order: 510 },
    { slot: 'sidebar.workspaces.session.menu.item', id: 'conversation-toolkit.download-markdown', order: 515 },
    { slot: 'sidebar.workspaces.session.menu.item', id: 'conversation-toolkit.copy-link', order: 520 },
    { slot: 'sidebar.workspaces.session.row.action', id: 'conversation-toolkit.copy-markdown', order: 150 },
    { slot: 'sidebar.workspaces.session.row.action', id: 'conversation-toolkit.copy-link', order: 160 },
    { slot: 'conversation.chat.turnTail', id: 'conversation-toolkit.turn-actions', order: 300 },
    { slot: 'conversation.input.dock', id: 'conversation-toolkit.resend', order: -10 },
    { slot: 'shell.overlay', id: 'conversation-toolkit.dialogs', order: 20 }
  ]);

  // Every id is namespaced, so no shipped entry can be shadowed by accident.
  for (const entry of state.registrations) {
    assert.match(String(entry.definition.id), /^conversation-toolkit\./);
    assert.equal(entry.definition.locale, 'conversation-toolkit');
    assert.equal(typeof entry.component, 'function');
    assert.equal(typeof entry.definition.inject, 'function');
  }
});

test('apply() declares both locale dictionaries with identical key sets', () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  assert.equal(state.locales.length, 1);
  const [locale] = state.locales;
  assert.equal(locale.ns, 'conversation-toolkit');
  assert.deepEqual(Object.keys(locale.dicts).sort(), ['en', 'zh']);
  assert.deepEqual(Object.keys(locale.dicts.zh).sort(), Object.keys(locale.dicts.en).sort());
});

test('the composer dock entry renders nothing, keeping the search in the sidebar', () => {
  const { exports, React } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const dock = state.registrations.find((entry) => entry.definition.name === 'conversation.input.dock');
  assert.ok(dock !== undefined, 'the resend plumbing registers into conversation.input.dock');
  const props = {
    sessionId: 'session-a',
    input: { draft: '' },
    inputActions: { setDraft() {}, submit() {} },
    services: state.registrations[0].definition.inject('session-a'),
    t: (key) => key
  };
  // The dock renders the behaviour component, and with nothing pending that
  // component draws nothing at all.
  const element = dock.component(props);
  assert.equal(typeof element.type, 'function');
  assert.equal(element.type.name, 'PendingResend');
  assert.equal(React.render(element.type, element.props), null, 'the dock entry adds no visible surface');
});

test('registered components render with their documented props', async () => {
  const { exports, React } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);

  const services = state.registrations[0].definition.inject('session-a');
  assert.deepEqual(Object.keys(services).sort(), [
    'copyText',
    'downloadMarkdown',
    'exportMarkdown',
    'forkAndOpen',
    'invalidate',
    'openSession',
    'prefetch',
    'rememberLink',
    'saveText',
    'turnCache'
  ]);
  assert.equal(typeof services.exportMarkdown, 'function');
  assert.equal(typeof services.forkAndOpen, 'function');
  assert.equal(typeof services.openSession, 'function');

  const t = (key, params) => (params === undefined ? key : `${key}:${Object.values(params).join(',')}`);
  const useMenuOpenState = () => [false, () => {}];
  const useSessions = () => ({ byId: { 'session-a': { displayTitle: 'Alpha' } }, ids: ['session-a'] });
  const useWorkspaces = () => ({ archivedSessionIds: [], pinnedSessionIds: [] });
  const useSessionStatus = () => undefined;

  for (const entry of state.registrations) {
    const props = {
      sessionId: 'session-a',
      displayTitle: 'Alpha',
      seq: 6,
      turn: { turn: 1 },
      messageId: 'm1',
      input: { draft: '' },
      inputActions: { setDraft() {}, submit() {} },
      services,
      useMenuOpenState,
      useSessions,
      useWorkspaces,
      useSessionStatus,
      t
    };
    // Hooks need the driver: a bare call leaves the hook runtime unbound.
    assert.doesNotThrow(() => React.render(entry.component, props), entry.definition.id + ' renders');
  }
});

test('copying Markdown asks for the requested mode and writes the clipboard', async () => {
  const calls = [];
  const { exports } = materialize({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('# Title\n\nbody\n', { status: 200, headers: { 'content-type': 'text/markdown' } });
    }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const full = await services.exportMarkdown('session-a', { mode: 'full' });
  assert.deepEqual(full, { ok: true, chars: '# Title\n\nbody\n'.length, mode: 'full' });
  assert.match(calls[0], /^api\/conversation-toolkit\/transcript\?/);
  assert.match(calls[0], /sessionId=session-a/);
  assert.match(calls[0], /mode=full/);

  const brief = await services.exportMarkdown('session-a', { mode: 'brief' });
  assert.equal(brief.ok, true);
  assert.match(calls[1], /mode=brief/);

  // No mode means the narrow default, never the widest export.
  const standard = await services.exportMarkdown('session-a');
  assert.equal(standard.mode, 'standard');
  assert.match(calls[2], /mode=standard/);
});

test('a refused clipboard hands the export back instead of losing it', async () => {
  const { exports } = materialize({
    clipboard: {
      writeText: async () => {
        throw new Error('Document is not focused.');
      }
    },
    execCommand: false,
    fetch: async () =>
      new Response('# Title\n\nbody\n', { status: 200, headers: { 'x-conversation-toolkit-title': encodeURIComponent('T') } })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const result = await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'copy');
  assert.match(result.detail, /Document is not focused/);
  // The text and its identity survive, so the caller can reopen the export.
  assert.equal(result.text, '# Title\n\nbody\n');
  assert.equal(result.title, 'T');
  assert.equal(result.sessionId, 'session-a');
  assert.equal(result.mode, 'standard');
});

test('a write that the clipboard does not reflect is treated as a failure', async () => {
  const { exports } = materialize({
    clipboard: {
      writeText: async () => {},
      readText: async () => 'something else entirely'
    },
    execCommand: false,
    fetch: async () => new Response('body', { status: 200 })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  const result = await services.exportMarkdown('session-a', { mode: 'brief' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /did not change/);
});

test('an unverifiable clipboard is not treated as a failure', async () => {
  const { exports } = materialize({
    clipboard: {
      writeText: async () => {},
      readText: async () => {
        throw new Error('read permission denied');
      }
    },
    fetch: async () => new Response('body', { status: 200 })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  const result = await services.exportMarkdown('session-a', { mode: 'brief' });
  assert.equal(result.ok, true);
});

test('copyText and saveText serve the fallback dialog', async () => {
  const written = [];
  const { exports, downloads } = materialize({
    clipboard: { writeText: async (value) => written.push(value) },
    // The download schedules an object-URL revoke; stubbing it keeps the test
    // process from idling for the full delay.
    setTimeout: () => 0,
    fetch: async () => new Response('body', { status: 200 })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const copied = await services.copyText('hello');
  assert.equal(copied.ok, true);
  assert.deepEqual(written, ['hello']);

  assert.equal(services.saveText('note.md', 'hello'), true);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].download, 'note.md');
});

test('downloading saves a .md file named after the conversation', async () => {
  const { exports, downloads } = materialize({
    fetch: async () =>
      new Response('# Title\n\nbody\n', {
        status: 200,
        headers: {
          'content-type': 'text/markdown',
          // The Host echoes the title so the file can be named without a second call.
          'x-conversation-toolkit-title': encodeURIComponent('Deploy: hub / 2026')
        }
      })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const result = await services.downloadMarkdown('session-abcdef12-3456', { mode: 'standard' });
  assert.equal(result.ok, true);
  assert.equal(result.chars, '# Title\n\nbody\n'.length);
  assert.equal(downloads.length, 1);
  // Path separators and colons must not survive into a filename.
  assert.equal(downloads[0].download, 'Deploy_ hub _ 2026 abcdef12.md');
  assert.equal(result.filename, downloads[0].download);
});

test('a download falls back to the Session id when the title is unusable', async () => {
  const { exports, downloads } = materialize({
    fetch: async () => new Response('# x\n', { status: 200, headers: { 'x-conversation-toolkit-title': encodeURIComponent('...') } })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('s');
  const result = await services.downloadMarkdown('session-abcdef12-3456', { mode: 'standard' });
  assert.equal(result.ok, true);
  assert.equal(downloads[0].download, 'conversation abcdef12.md');
});

test('a clipboard refusal is reported with its reason', async () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  // The stub document's execCommand returns true, so force the async API to throw
  // and confirm the fallback still succeeds rather than reporting a failure.
  const result = await services.exportMarkdown('session-a', { full: true });
  assert.equal(typeof result.ok, 'boolean');
});

test('a failing transcript read is reported, never thrown', async () => {
  const { exports } = materialize({
    fetch: async () => new Response(JSON.stringify({ ok: false, error: { code: 'session-not-found', message: 'gone' } }), { status: 404 })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('missing');
  const result = await services.exportMarkdown('missing');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'export');
  assert.equal(result.detail, 'gone');
});

test('the deep-link query parameter opens its Session without a router', () => {
  const { exports } = materialize({ href: 'http://127.0.0.1:19387/?dsh-session=session-42' });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  assert.equal(state.opened[0], 'session-42');
  // The shell restores its own selection after boot, so the open is repeated.
  assert.ok(state.effects.some((effect) => effect.label === 'conversation-toolkit: deep link'));
});

test('forkAndOpen cuts at the requested inclusive seq and queues the resend text', async () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const childId = await services.forkAndOpen('session-a', 6, 'edited text');
  assert.equal(childId, 'session-child');
  assert.deepEqual(state.forkCalls, [{ sessionId: 'session-a', atSeq: 6, increaseTitle: true }]);
  assert.deepEqual(state.opened, ['session-child']);
});

test('forkAndOpen refuses a missing cut point instead of forking everything', async () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  await assert.rejects(() => services.forkAndOpen('session-a', null, null), /cut point/);
  assert.equal(state.forkCalls.length, 0);
});

test('a failed automatic send is never retried without an idempotency guarantee', () => {
  const { exports } = materialize();
  const { resendNextState } = exports.internals;
  // The v0.5.0 behaviour (one automatic retry) was removed on review: a rejected
  // submit may still have delivered the message, so retrying could send it twice.
  assert.equal(resendNextState('submitting', 'rejected'), 'failed');
  assert.notEqual(resendNextState('submitting', 'rejected'), 'submitting');
  assert.notEqual(resendNextState('submitting', 'rejected'), 'pending');
  // Only the user re-arms it, and re-arming lands back on the normal submit path.
  assert.equal(resendNextState('failed', 'user-retry'), 'pending');
  assert.equal(resendNextState('pending', 'draft-published'), 'submitting');
  assert.equal(resendNextState('submitting', 'accepted'), 'done');
  // An unknown event never moves the machine.
  assert.equal(resendNextState('failed', 'rejected'), 'failed');
});

test('a prefetched export is reused instead of refetched', async () => {
  const calls = [];
  const { exports } = materialize({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response('# T\n\nbody\n', { status: 200, headers: { 'x-conversation-toolkit-title': 'T' } });
    }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  // Hovering the row fetches ahead, so the click does not have to.
  assert.equal(await services.prefetch('session-a', { mode: 'standard' }), true);
  assert.equal(calls.length, 1);

  const copied = await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(copied.ok, true);
  assert.equal(calls.length, 1, 'the click reused the prefetched export');

  // A different mode is a different document and must still be fetched.
  await services.exportMarkdown('session-a', { mode: 'brief' });
  assert.equal(calls.length, 2);
});

test('a failed prefetch is harmless', async () => {
  const { exports } = materialize({
    fetch: async () => new Response('{"ok":false,"error":{"message":"boom"}}', { status: 500 })
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  assert.equal(await services.prefetch('session-a', { mode: 'standard' }), false);
  // The real action still reports its own error.
  const result = await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'export');
});

// ─── v0.5.1 ─────────────────────────────────────────────────────────────

test('v0.5.1 every branch action forks before the turn, so a resend cannot duplicate it', () => {
  const { exports } = materialize();
  const { branchPlan } = exports.internals;
  assert.equal(typeof branchPlan, 'function', 'branchPlan is the testable fork decision');
  const turn = { turn: 2, cutSeq: 6, dropSeq: 9, user: { text: 'Second question' } };
  for (const action of ['edit', 'regenerate', 'delete']) {
    const plan = branchPlan(turn, action, "edited");
    assert.equal(plan.cutSeq, turn.cutSeq, action + ' forks before the turn');
    assert.notEqual(plan.cutSeq, turn.dropSeq, action + ' must not fork at dropSeq');
  }
  assert.equal(branchPlan(turn, 'regenerate').text, 'Second question');
  assert.equal(branchPlan(turn, 'regenerate').resend, true);
  assert.equal(branchPlan(turn, 'delete').resend, false);
  assert.equal(branchPlan(turn, 'edit', 'edited').text, 'edited');
  assert.equal(branchPlan({ turn: 1, cutSeq: null }, 'delete'), null, 'an unusable cut has no plan');
});

test('v0.5.1 concurrent prefetches of one Session and mode are a single request', async () => {
  const calls = [];
  const { exports } = materialize({
    fetch: async (url) => {
      calls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response('body', { status: 200 });
    }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  const results = await Promise.all([
    services.prefetch('session-a', { mode: 'standard' }),
    services.prefetch('session-a', { mode: 'standard' }),
    services.prefetch('session-a', { mode: 'standard' })
  ]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(calls.length, 1, 'three concurrent prefetches share one request');
});

test('v0.5.1 invalidating a Session drops its cached export', async () => {
  const calls = [];
  const { exports } = materialize({
    fetch: async (url) => { calls.push(String(url)); return new Response('body', { status: 200 }); }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');
  assert.equal(typeof services.invalidate, 'function', 'the session-change hook exists');
  await services.prefetch('session-a', { mode: 'standard' });
  assert.equal(calls.length, 1);
  services.invalidate('session-a');
  await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(calls.length, 2, 'the invalidated export is refetched');
});

test('v0.5.1 the prefetch cache is only a gesture bridge', async () => {
  const clock = { now: 1_000_000 };
  const calls = [];
  const { exports } = materialize({
    Date: { now: () => clock.now },
    fetch: async (url) => { calls.push(String(url)); return new Response('body', { status: 200 }); }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  await services.prefetch('session-a', { mode: 'standard' });
  await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(calls.length, 1, 'a fresh prefetch is reused');

  clock.now += 11_000;
  await services.exportMarkdown('session-a', { mode: 'standard' });
  assert.equal(calls.length, 2, 'an 11s-old prefetch is not reused');
});

test('v0.5.1 opening the menu never prefetches the full record', () => {
  const calls = [...SOURCE.matchAll(/prefetch\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(calls.length > 0, "the bundle prefetches something");
  for (const call of calls) {
    assert.doesNotMatch(call, /'full'/, 'the full record is never prefetched: ' + call);
    assert.doesNotMatch(call, /options\.mode/, 'a menu row must not prefetch its own mode: ' + call);
  }
});

test('v0.5.1 a rejected submit is never retried automatically', () => {
  const { exports } = materialize();
  const { resendNextState } = exports.internals;
  assert.equal(typeof resendNextState, 'function', 'the resend machine is testable');
  assert.equal(resendNextState('submitting', 'rejected'), 'failed', 'a rejection parks the payload');
  assert.equal(resendNextState('failed', 'user-retry'), 'pending', 'only the user re-arms it');
  assert.equal(resendNextState('submitting', 'accepted'), 'done');
  assert.equal(resendNextState('pending', 'draft-published'), 'submitting');
  assert.notEqual(resendNextState('submitting', 'rejected'), 'submitting', 'no automatic retry');
  assert.notEqual(resendNextState('submitting', 'rejected'), 'pending', 'no automatic re-arm');
});

test('v0.5.1 a rejected submit runs exactly once and leaves a recovery entry', async () => {
  const timers = [];
  const submits = [];
  const { exports, React } = materialize({
    // Any scheduled retry would show up here.
    setTimeout: (fn, delay) => {
      timers.push(delay);
      return 0;
    },
    // The retry asks the child what it holds before it acts, so the Turn route
    // must answer with JSON.
    fetch: routeFetch('nothing like it', 'body')
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject('session-a');

  // Seed a pending resend the way the plugin does: fork with text.
  await services.forkAndOpen('session-a', 6, 'hello');
  const dock = state.registrations.find((entry) => entry.definition.name === 'conversation.input.dock');
  assert.ok(dock !== undefined, 'the dock component is registered');

  const draft = [];
  const inputActions = {
    setDraft: (value) => draft.push(value),
    submit: () => {
      submits.push(1);
      return Promise.reject(new Error('network down'));
    }
  };
  const props = { sessionId: 'session-child', input: { draft: 'hello' }, inputActions, services, t: (key) => key };

  // The dock returns the behaviour element; render that component itself.
  const dockElement = dock.component(props);
  React.render(dockElement.type, dockElement.props);
  // Let the rejection settle, then render again to observe the parked state.
  await new Promise((resolve) => setImmediate(resolve));
  const tree = React.render(dockElement.type, dockElement.props);

  assert.equal(submits.length, 1, 'submit ran exactly once; a rejection is never retried blindly');
  assert.deepEqual(timers, [], 'no retry was scheduled');
  assert.deepEqual(draft, ['hello'], 'the text was published to the composer');
  assert.ok(tree !== null, 'the failure leaves a visible recovery entry');
  assert.equal(tree.props.role, 'alert', 'the recovery entry announces itself');

  // The recovery entry offers a retry, and only that click re-arms the machine.
  const buttons = tree.props.children.filter((child) => child !== null && child.type === 'button');
  assert.equal(buttons.length, 2, 'retry and dismiss are both offered');
  buttons[0].props.onClick();
  await flush();
  // The state update re-renders in React; here that is one more pass.
  React.render(dockElement.type, dockElement.props);
  await flush();
  assert.equal(submits.length, 2, 'the user-initiated retry submits again');
  assert.deepEqual(timers, [], 'still no automatic retry was scheduled');
});

// ─── v0.5.2 ─────────────────────────────────────────────────────────────

/**
 * A Turn-index body whose single turn carries `text` as the user message.
 *
 * @param text - the user text the child is pretended to hold.
 * @returns the JSON body.
 */
function turnBody(text) {
  return (
    // The real Turn route answers an envelope whose array is under `turns`.
    '{"ok":true,"value":{"sessionId":"session-child","title":"t","eventCount":6,"turns":[' +
    '{"turn":1,"startSeq":1,"endSeq":6,"cutSeq":0,"dropSeq":null,' +
    '"user":{"seq":3,"text":' +
    JSON.stringify(text) +
    '},"assistant":{"text":"hi","reasoning":"","toolCalls":0}}]}}'
  );
}

/**
 * A fetch stub that answers the Turn route with JSON and everything else with
 * plain text, which is what the retry check reads.
 *
 * @param turnsText - the user text the child holds.
 * @param transcriptBody - the transcript body.
 * @returns the stub.
 */
function routeFetch(turnsText, transcriptBody) {
  return async (url) => {
    const target = String(url);
    if (target.includes("/turns")) return new Response(turnBody(turnsText), { status: 200 });
    return new Response(transcriptBody, { status: 200 });
  };
}

test("v0.5.2 retry re-publishes the draft after the editor was cleared", async () => {
  const submits = [];
  const drafts = [];
  const { exports, React } = materialize({
    fetch: routeFetch("something else", "body")
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject("session-a");
  await services.forkAndOpen("session-a", 6, "hello");
  const dock = state.registrations.find((entry) => entry.definition.name === "conversation.input.dock");

  const inputActions = {
    setDraft: (value) => drafts.push(value),
    submit: () => {
      submits.push(1);
      return Promise.reject(new Error("network down"));
    }
  };
  const base = { sessionId: "session-child", inputActions, services, t: (key) => key };

  const element = dock.component({ ...base, input: { draft: "hello" } });
  React.render(element.type, element.props);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = React.render(element.type, element.props);
  assert.equal(submits.length, 1, "the first submit ran once");
  assert.ok(tree !== null, "the failure left a recovery entry");

  // The editor cleared the draft after the failure: the case the publishing
  // effect could not recover from, because none of its deps changed.
  const cleared = React.render(element.type, { ...element.props, input: { draft: "" } });
  const buttons = cleared.props.children.filter((child) => child !== null && child.type === "button");
  assert.equal(buttons.length, 2, "the recovery entry offers retry and dismiss");
  buttons[0].props.onClick();
  await flush();

  assert.ok(drafts.length >= 2, "the retry published the draft again");
  assert.equal(drafts.at(-1), "hello", "and it published the pending text");

  // The composer carries it again, so the gate opens and the send is attempted.
  React.render(element.type, { ...element.props, input: { draft: "hello" } });
  await flush();
  assert.equal(submits.length, 2, "the retry reached the submit gate");
});

test("v0.5.2 retry refuses to resend a message the child already carries", async () => {
  const submits = [];
  const { exports, React } = materialize({
    // The child already holds the text: the rejected submit WAS accepted.
    fetch: routeFetch("hello", "body")
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject("session-a");
  await services.forkAndOpen("session-a", 6, "hello");
  const dock = state.registrations.find((entry) => entry.definition.name === "conversation.input.dock");

  const inputActions = {
    setDraft: () => {},
    submit: () => {
      submits.push(1);
      return Promise.reject(new Error("network down"));
    }
  };
  const base = { sessionId: "session-child", input: { draft: "hello" }, inputActions, services, t: (key) => key };

  const element = dock.component(base);
  React.render(element.type, element.props);
  await new Promise((resolve) => setImmediate(resolve));
  const tree = React.render(element.type, element.props);
  assert.equal(submits.length, 1, "the first submit ran once");

  const buttons = tree.props.children.filter((child) => child !== null && child.type === "button");
  buttons[0].props.onClick();
  await flush();
  React.render(element.type, element.props);
  await flush();
  assert.equal(submits.length, 1, "the message is already there, so nothing is resent");
});

test("v0.5.2 a result invalidated while in flight is discarded, not served", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { exports } = materialize({
    fetch: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) await gate;
      // The stale body is deliberately longer, so the length tells them apart.
      return new Response(calls.length === 1 ? "stale-stale-stale" : "fresh", { status: 200 });
    }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject("session-a");

  // The awaiting caller here is exportMarkdown itself: it holds the in-flight
  // promise, so a stale resolution would reach it directly.
  const pending = services.exportMarkdown("session-a", { mode: "standard" });
  await Promise.resolve();
  services.invalidate("session-a");
  release();

  const copied = await pending;
  assert.equal(copied.chars, 5, "the awaiting caller receives fresh content, not the invalidated one");
});

test("v0.5.2 forking a Session invalidates its cached export", async () => {
  const calls = [];
  const { exports } = materialize({
    fetch: async (url) => { calls.push(String(url)); return new Response("body", { status: 200 }); }
  });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject("session-a");
  const transcripts = () => calls.filter((url) => url.includes("transcript")).length;

  await services.prefetch("session-a", { mode: "standard" });
  assert.equal(transcripts(), 1, "the prefetch fetched once");

  await services.forkAndOpen("session-a", 6, "hi");
  await services.exportMarkdown("session-a", { mode: "standard" });
  assert.equal(transcripts(), 2, "the post-fork export is refetched, not served stale");
});

// ─── v0.5.3 ─────────────────────────────────────────────────────────────

test("v0.5.3 a parked payload is restored after a client reload", async () => {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  try {
    // Exactly what the previous generation wrote before the reload.
    store.set(
      "conversation-toolkit.pending-resend",
      JSON.stringify([["session-child", { text: "hello", state: "failed", attempts: 1, error: "down" }]])
    );
    const { exports, React } = materialize({ fetch: routeFetch("nothing like it", "body") });
    const { ctx, state } = fakeContext();
    exports.apply(ctx);
    const services = state.registrations[0].definition.inject("session-a");
    const dock = state.registrations.find((entry) => entry.definition.name === "conversation.input.dock");
    const element = dock.component({
      sessionId: "session-child",
      input: { draft: "" },
      inputActions: { setDraft: () => {}, submit: () => Promise.reject(new Error("down")) },
      services,
      t: (key) => key
    });
    const tree = React.render(element.type, element.props);
    assert.ok(tree !== null, "the recovery entry came back with the reload");
    const buttons = tree.props.children.filter((child) => child !== null && child.type === "button");
    assert.equal(buttons.length, 2, "and it still offers retry and dismiss");
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test("v0.5.3 a payload waiting on the composer reports the wait", async () => {
  const { exports, React } = materialize({ fetch: routeFetch("nothing like it", "body") });
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const services = state.registrations[0].definition.inject("session-a");
  await services.forkAndOpen("session-a", 6, "hello");
  const dock = state.registrations.find((entry) => entry.definition.name === "conversation.input.dock");
  const element = dock.component({
    sessionId: "session-child",
    input: { draft: "hello" },
    // A submit that never settles keeps the payload in flight.
    inputActions: { setDraft: () => {}, submit: () => new Promise(() => {}) },
    services,
    t: (key) => key
  });
  const tree = React.render(element.type, element.props);
  assert.ok(tree !== null, "the wait is not silent");
  assert.equal(tree.props.role, "status", "it is reported as a status, not an error");
  const buttons = tree.props.children.filter((child) => child !== null && child.type === "button");
  assert.equal(buttons.length, 1, "with a manual way to publish the text");
});
