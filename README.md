# dsh-plugin-conversation-toolkit

English | [中文](README.zh.md)

A native plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that adds the conversation
affordances the app does not ship: export a conversation as Markdown, copy a link that reopens it, edit a user
message and resend it, branch a turn away, and search every conversation from above the composer.

![extension points](https://img.shields.io/badge/DSH%20client%20plugin-slots-blue)

## Features

| Feature | Where it appears |
|---|---|
| **Copy a conversation as Markdown** | Sidebar session `…` menu, and a hover button on every session row |
| **Copy a conversation deep link** | Same two places — the link reopens that conversation |
| **Global conversation search** | A search bar directly **above the composer card**, searching message content across every session |
| **Edit a user message and resend** | Turn action row under each completed turn |
| **Regenerate a turn** | Same row — drops that turn's reply *and its reasoning*, then asks again |
| **Delete a turn and everything after** | Same row |
| **Copy one turn** | Same row — user text, reasoning and answer as Markdown |

Every label is localized (Simplified Chinese and English) and follows the app's active locale.

## Install

```sh
# from a DSH session, or with the dsh CLI:
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-conversation-toolkit
```

Or, from an agent session, install the directory as a bundle:

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-conversation-toolkit
```

The bundle patch inserts one Host row. The browser half is discovered automatically from this package's
`dsh.client` declaration and `exports["./client"]`, so no second row is needed. Installation applies live through
HMR; a profile that only mounts the package at startup needs one restart.

Requirements: DSH `0.2.0-rc.2` or a compatible release, with the `sessionQuery` service mounted (shipped by
`@deepseek-ai/dsh-base` via `dsh-session-query-sqlite`).

## How it works

The plugin is two halves with one shared idea: **the Session log is the only source of truth, and it is read-only.**

### Host half — `lib/index.js`

Registers two exact Fetch routes on the `connection` service. It imports no Harness package (a third-party bundle
is resolved from its own real path, so `import '@deepseek-ai/…'` fails with `ERR_MODULE_NOT_FOUND`), reads
services through `ctx.get(...)`, and declares no Session event type and no Remote namespace.

| Route | Answer |
|---|---|
| `GET /api/conversation-toolkit/transcript?sessionId=…&reasoning=0\|1&tools=0\|1&meta=0\|1&format=md\|json` | the conversation as Markdown (or a JSON envelope) |
| `GET /api/conversation-toolkit/turns?sessionId=…` | one record per Turn, with the inclusive sequence numbers a rewrite forks at |

Both are reads over `ctx.sessionQuery.readSession(id)`, the same replay-validated path the app uses to resume a
conversation. Failures come back as `{ ok: false, error: { code, message } }` with a real HTTP status —
`session-not-found` is a 404, an unreadable log a 500, a profile without `sessionQuery` a 503.

### Client half — `client/client.js`

One hand-written browser bundle in the lazy-CJS form the Harness module loader expects
(`window.__ModuleLoader__.load({ id, factory })`). It requires exactly one module — `react` — from the platform
seed table; per the shipped authoring guidance every control is written locally and styled only with
`--dsw-alias-*` theme tokens, so a renamed token degrades appearance rather than blanking the slot.

| Slot | Entry |
|---|---|
| `sidebar.workspaces.session.menu.item` | `copy-markdown` (500), `copy-link` (510) |
| `sidebar.workspaces.session.row.action` | `copy-markdown` (150), `copy-link` (160) |
| `conversation.chat.turnTail` | `turn-actions` (300) |
| `conversation.input.dock` | `global-search` (−10, so it leads the shipped `todo`/`goal`/`queue` entries) |
| `shell.overlay` | `dialogs` (20) — the edit dialog, the confirm dialog and the toast |

### Why editing is a branch, not a rewrite

DSH persists a conversation as an **append-only** log: committed events are never rewritten, and the only
transcript-cut primitive the platform exposes is

```js
session.fork({ sessionId, atSeq })   // atSeq is an INCLUSIVE cut
```

There is no edit, delete, truncate, rewind or resend API anywhere in the release — a full scan of the client
bundles finds zero matches for `rollback`, `rewind`, `resend`, `editMessage`, `deleteMessage`,
`removeMessage`, `hideThinking` or `truncateMessages`.

So every action here is expressed as a cut plus, optionally, one resend:

| Action | Cut | Then |
|---|---|---|
| Edit and resend | the event before the turn's `turn/start` | open the child, fill the composer with the edited text, submit it |
| Regenerate | the turn's `user/message` sequence | open the child, resubmit the original text |
| Delete this turn and after | the event before the turn's `turn/start` | open the child |

**The source conversation is never modified.** Each action creates a new Session and opens it, which is the same
mechanism the shipped "branch" button uses. A mistake costs one extra session in the sidebar, never history.

### Deep links without a router

DSH's Web shell contains no routing code at all — it never calls `pushState`, `replaceState` or reads
`location.search`; the open conversation lives in `localStorage["dsh.sessions.current"]`. That leaves the query
string free:

```
http://127.0.0.1:19387/?dsh-session=<sessionId>
```

The plugin writes that link, and on boot reads the same parameter and calls `uiWorkspace.openSession(id)`
(repeated a few times, because the shell's own `restoreSelection` settles after the lists become ready). The
server serves the index for a cookie-authenticated root request with extra parameters, so the link works in the
same browser without any server change.

## Verification

```sh
npm test        # 34 tests: transcript folding, turn indexing, host routes, client bundle contract
```

- `test/transcript.test.mjs` — Markdown and Turn folding against a synthetic two-turn log **and** against the
  largest real `session.v4.jsonl.zstd` in the local Harness home, asserting that every computed cut point
  addresses an event that actually exists (which is what `session.fork` requires).
- `test/host-routes.test.mjs` — the wire contract: route paths, methods, defaults, status codes, error envelopes.
- `test/client-bundle.test.mjs` — the bundle parses, registers the factory id the loader demands, requires only
  `react`, declares both locale dictionaries with identical key sets, registers exactly the seven claimed
  entries, and renders each component with its documented props.

Verified live in the running app: all seven entries report `active: true` through the client slot inspector, at
the orders listed above.

## Known limitations

- **No whole-session delete.** DSH exposes no delete RPC for Sessions — only `workspace/archiveSession`. This
  plugin therefore does not remove conversations; use the shipped Archive action. Deleting the stored
  `session.v4.jsonl.zstd` by hand would also desynchronise the SQLite search index, so it is deliberately out.
- **Deleting a turn also deletes the reply to it.** Reasoning cannot be removed on its own: reasoning is part of
  the assistant step that produced it, and rewriting a stored event is impossible by design. "Regenerate" is the
  honest version of "delete the thinking process" — it drops the whole step and asks again.
- **Actions are disabled while a Session is running**, because forking a live conversation produces a child whose
  prefix ends mid-turn.
- **Turn actions appear only after the turn index loads** (one request per Session, cached for the page's
  lifetime). They render nothing until then rather than guessing a cut point.
- **A deep link only works in a browser that is already authenticated** to that Harness instance — it is a link
  into your local app, not a share link.

## License

MIT
