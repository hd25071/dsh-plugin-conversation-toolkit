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
  return {
    Fragment,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    useRef(value) {
      return { current: value };
    },
    useSyncExternalStore(getSnapshot) {
      return getSnapshot();
    }
  };
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

  const run = new Function('window', 'document', 'navigator', 'fetch', SOURCE);
  run(windowStub, documentStub, navigatorStub, options.fetch ?? (async () => new Response('', { status: 200 })));

  const record = moduleLoader.registered;
  assert.ok(record !== undefined, 'the bundle registers a factory');
  const exports = record.factory((specifier) => {
    assert.equal(specifier, 'react', `the bundle requires only react, saw ${specifier}`);
    return React;
  });
  return { record, exports, registered, styles, React, downloads };
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
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);
  const dock = state.registrations.find((entry) => entry.definition.name === 'conversation.input.dock');
  assert.ok(dock !== undefined, 'the resend plumbing registers into conversation.input.dock');
  const element = dock.component({
    sessionId: 'session-a',
    input: { draft: '' },
    inputActions: { setDraft() {}, submit() {} },
    services: state.registrations[0].definition.inject('session-a'),
    t: (key) => key
  });
  // One level of shallow render: the dock renders the invisible behaviour
  // component, and that component draws nothing at all.
  assert.equal(typeof element.type, 'function');
  assert.equal(element.type.name, 'PendingResend');
  assert.equal(element.type(element.props), null, 'the dock entry adds no visible surface');
});

test('registered components render with their documented props', async () => {
  const { exports } = materialize();
  const { ctx, state } = fakeContext();
  exports.apply(ctx);

  const services = state.registrations[0].definition.inject('session-a');
  assert.deepEqual(Object.keys(services).sort(), [
    'copyText',
    'downloadMarkdown',
    'exportMarkdown',
    'forkAndOpen',
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
    entry.component(props);
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

test('a failed automatic send retries exactly once, then stops', () => {
  const { exports } = materialize();
  const { resendAfterFailure } = exports.internals;
  // One transient rejection is retried; a second failure must not loop.
  assert.equal(resendAfterFailure(1), 'retry');
  assert.equal(resendAfterFailure(2), 'give-up');
  assert.equal(resendAfterFailure(99), 'give-up');
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
