# dsh-plugin-conversation-toolkit

English | [中文](README.zh.md)

A native plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that adds the conversation
affordances the app does not ship: export a whole conversation as Markdown, save it as a file, copy a link that
reopens it, edit a user message and resend it, and branch a turn away.

## Features

| Feature | Where it appears |
|---|---|
| **Copy as Markdown — standard** (dialogue + tool names) | Sidebar session `…` menu and a hover button on every session row |
| **Copy the full record** (thinking, arguments, results) | Sidebar session `…` menu — asks first, because it can leak |
| **Copy the dialogue only** | Sidebar session `…` menu |
| **Download the conversation as a `.md` file** | Sidebar session `…` menu |
| **Copy a conversation deep link** | Sidebar session `…` menu and the row hover strip |
| **Edit a user message and resend** | Turn action row under each completed turn |
| **Regenerate a turn** | Same row — drops that turn's reply *and its reasoning*, then asks again |
| **Delete a turn and everything after** | Same row |
| **Copy one turn** | Same row — user text, reasoning and answer as Markdown |

Every label is localized (Simplified Chinese and English) and follows the app's active locale.

A long conversation exports to well over a megabyte in full mode, so the **download** row exists as the action that
always works: it never touches the clipboard, the secure-context rules, or a paste target's size limits.

## Install

```sh
# from a DSH session, or with the dsh CLI:
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-conversation-toolkit
```

Or, from an agent session, install the directory as a bundle:

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-plugin-conversation-toolkit
```

The bundle patch inserts one Host row. The browser half is discovered automatically from this package's `dsh.client`
declaration and `exports["./client"]`, so no second row is needed.

Requirements: DSH `0.2.0-rc.2` or a compatible release, with the `sessionQuery` service mounted (shipped by
`@deepseek-ai/dsh-base` via `dsh-session-query-sqlite`).

## Sidebar content search: read this before wondering why it only finds titles

The shipped sidebar search box looks like a name-only search, and **by default it is one**. `dsh-base` ships the
session-query index disabled, with this comment in its own patch:

```yaml
# Full-text session search is opt-in. `openAt: never` keeps ctx.sessionQuery mounted — exact reads, titles, and
# lineage traces ... stay available — while search calls fail with SESSION_QUERY_SEARCH_DISABLED and SQLite is never
# opened; the Web sidebar search matches titles and workspace names only. Deployments enabling content search
# override `openAt` to `first-search` or `startup` in a later patch layer (profile cordis.patch.yml ...),
# typically with a durable `path`.
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

To turn real content search on, add this to the profile's `cordis.patch.yml` (a Loader patch replaces the whole
`config` key, so `path` must be restated):

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: 'C:/Users/<you>/.dsh/cache/session-query.sqlite'
    openAt: first-search
    # The first build reads every stored Session before it writes anything, and
    # it is discarded wholesale if any Session is written meanwhile; more
    # concurrency shortens that fragile window.
    persistedReadConcurrency: 16
```

**The first search is the fragile one.** The engine reads the whole corpus, then re-lists persistence and throws
`SESSION_QUERY_PERSISTENCE_FAILED` if anything changed in between — and it writes nothing until that check passes, so
a failed attempt makes no progress. Run the first search while DSH is **idle** (no turn running, no subagents). Once
it succeeds the index is durable and every later search is incremental and fast.

After that the sidebar finds message content: it merges name matches with ranked full-text hits and shows a snippet
per result. `Ctrl/Cmd+K` focuses it.

## Export modes: what leaves the machine

A transcript can carry material that must not leave the machine by accident — thinking often quotes private context,
tool arguments carry absolute paths and sometimes tokens, and tool results are frequently file dumps or command
output. **The default is therefore the narrow one.**

| Mode | Dialogue | Thinking | Tool names | Tool arguments and results | System text | Compaction summaries | Workspace path | Header warning |
|---|---|---|---|---|---|---|---|---|
| `brief` | yes | — | — | — | — | — | — | — |
| `standard` **(default)** | yes | — | yes | — | — | — | — | — |
| `full` | yes | yes | yes | yes | yes | yes | yes | yes |

Two things worth stating outright:

- **A compaction summary is internal material.** It stands in for history the user never wrote, so it is
  only ever part of `full`.
- **The workspace path and the parent Session id are local-path metadata.** They name this machine's
  directory layout and another conversation, so they too are only written by `full`.

Neither of those narrows the residual risk, though: **your own messages are included verbatim in every
mode and can contain secrets.** The narrower modes only remove what the agent added — which is why every
export carries this line in its header:

```markdown
- **Careful**: your own messages are included verbatim and may contain secrets.
```

The legacy `reasoning`/`tools` switches are still accepted, and they can only ever **narrow** the mode:

| Request | Result |
|---|---|
| `mode=full` | full |
| `reasoning=false&tools=true` | standard — no thinking, and no tool payloads either |
| `reasoning=true&tools=false` | standard — no tool names or payloads, so dialogue only |
| `mode=nonsense` | standard, **even with** `reasoning=true` — an unknown mode is never widened into full |

`true` is read as a permission, never as a demand, so a mixed pair resolves to the intersection rather
than to the widest mode.

`standard` is the conversation plus the names of the tools that ran — readable without the payloads. `full` is the
only mode that can carry a secret, and it says so in the document itself:

```markdown
> [!WARNING]
> This export contains **thinking, tool-call arguments and tool results**.
> Those routinely carry API tokens, credentials, absolute local paths, file
> contents and command output. Read it before sharing it.
```

An unrecognised mode falls back to `standard`, never to `full`. The document header records which mode produced it,
so a file found later can be judged without opening it.

### Escaping

The document is Markdown, but `<details>`, `<summary>` and `<code>` are raw HTML, so any dynamic text placed inside
them is escaped — a tool name is model- and tool-influenced, and an unescaped `<` would inject markup into a file the
user is about to share. Text inside a Markdown **code span** is handled differently: a code span is literal, so
entities would print as `&lt;`, and what has to be neutralised there is the backtick that would close the span.

## What the Markdown export contains

The full export is the whole record, in log order:

```
# <session title>

- **Session**: `…`       - **Workspace**: `…`
- **Created**: …          - **Last model**: `…`
- **Turns**: 12           - **Events**: 431
- **Exported**: …

## Turn 1

### User
<the user's text>

#### Thinking
<the assistant's reasoning>

### Assistant
<the answer>

<details><summary>Tool call · <code>read</code></summary>
{ "file_path": "…" }
</details>

<details><summary>Tool result</summary>
…
</details>

---

## Turn 2
…
```

The compact variant keeps the `## Turn N`, `### User` and `### Assistant` sections and drops the thinking, the tool
calls, the tool results and the system text.

## How it works

The plugin is two halves with one shared idea: **the Session log is the only source of truth, and it is read-only.**

### Host half — `lib/index.js`

Registers two exact Fetch routes on the `connection` service. It imports no Harness package (a third-party bundle is
resolved from its own real path, so `import '@deepseek-ai/…'` fails with `ERR_MODULE_NOT_FOUND`), declares no Session
event type and no Remote namespace.

| Route | Answer |
|---|---|
| `GET /api/conversation-toolkit/transcript?sessionId=…&reasoning=0\|1&tools=0\|1&meta=0\|1&format=md\|json` | the conversation as Markdown (or a JSON envelope) |
| `GET /api/conversation-toolkit/turns?sessionId=…` | one record per Turn, with the inclusive sequence numbers a rewrite forks at |

Both are reads over `ctx.sessionQuery.readSession(id)`, the same replay-validated path the app uses to resume a
conversation. Failures come back as `{ ok: false, error: { code, message } }` with a real HTTP status —
`session-not-found` is a 404, an unreadable log a 500, a profile without `sessionQuery` a 503.

**Two Cordis traps are worth knowing.**

1. `sessionQuery` is provided by a *sibling* fiber, and Cordis resolves a service by walking the plugin's own ancestor
   chain — so plain property access throws `cannot get property "sessionQuery" without inject`, while `ctx.get(name)`
   (the documented reader "without the inject requirement") returns it. Every service read here goes through a guarded
   helper that uses `ctx.get` and never throws; `test/host-routes.test.mjs` models the Proxy behaviour, so a regression
   fails the suite instead of silently failing in the browser.
2. The Host half is an ES module loaded once per process generation. Editing it does **not** change the running app
   (see Development notes).

### Client half — `client/client.js`

One hand-written browser bundle in the lazy-CJS form the Harness module loader expects
(`window.__ModuleLoader__.load({ id, factory })`). It requires exactly one module — `react` — from the platform seed
table; per the shipped authoring guidance every control is written locally and styled only with `--dsw-alias-*` theme
tokens, so a renamed token degrades appearance rather than blanking the slot.

| Slot | Entry |
|---|---|
| `sidebar.workspaces.session.menu.item` | `copy-markdown` (500), `copy-markdown-brief` (505), `download-markdown` (508), `copy-link` (510) |
| `sidebar.workspaces.session.row.action` | `copy-markdown` (150), `copy-link` (160) |
| `conversation.chat.turnTail` | `turn-actions` (300) |
| `conversation.input.dock` | `resend` (−10) — renders nothing; it exists only because the dock is the one seat that receives both the Session identity and the composer's `input`/`inputActions`, which "edit and resend" needs |
| `shell.overlay` | `dialogs` (20) — the edit dialog, the confirm dialog and the toast |

### Why editing is a branch, not a rewrite

DSH persists a conversation as an **append-only** log: committed events are never rewritten, and the only
transcript-cut primitive the platform exposes is

```js
session.fork({ sessionId, atSeq })   // atSeq is an INCLUSIVE cut
```

There is no edit, delete, truncate, rewind or resend API anywhere in the release — a full scan of the client bundles
finds zero matches for `rollback`, `rewind`, `resend`, `editMessage`, `deleteMessage`, `removeMessage`, `hideThinking`
or `truncateMessages`.

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
`location.search`; the open conversation lives in `localStorage["dsh.sessions.current"]`. That leaves the query string
free:

```
http://127.0.0.1:19387/?dsh-session=<sessionId>
```

The plugin writes that link, and on boot reads the same parameter and calls `uiWorkspace.openSession(id)` (repeated a
few times, because the shell's own `restoreSelection` settles after the lists become ready). The server serves the
index for a cookie-authenticated root request with extra parameters, so the link works in the same browser without any
server change.

## Development notes

- **The browser half hot-reloads; the Host half does not.** `dsh-client-hmr` stat-polls each package's bundle
  (mtime/ctime/size, ~500 ms) and swaps it into the open page, so client edits are instant. Host modules are only
  watched when `hmr.root` names their directory, and the base bundle ships `hmr.root: []`. To make Host edits reload,
  add to the profile's `cordis.patch.yml`:

  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    config:
      root:
        - "/absolute/path/to/dsh-plugin-conversation-toolkit"
  ```

  Without it, re-import a fresh module generation with `plugin_manager action=set_bundle enabled=false` followed by
  `enabled=true` — this works, while a plain file touch does not — or restart DSH.
- **Slot entries report their own crashes.** `cordis_inspect_query` → client `Slots.listSubTree` with `root=<slot>`
  lists occupants with an `active` flag; `active: false` means the component threw while rendering and its cell fell
  back to the next survivor. That is the fastest way to see a broken registration, and — with a temporary entry whose
  `id` carries a value — it is also how the Host half's reachability and the search backend were diagnosed without a
  readable browser console.

## Verification

```sh
npm run check   # syntax-check every source file, then run the suite
npm test        # 71 tests
```

CI runs `npm run check` on **ubuntu-latest** and **windows-latest**, and prints the pass and skip counts
as one explicit line on the run summary.

**Read the skip count, not just the pass count.** Two tests are marked `integration:` and need a real
`session.v4.jsonl.zstd` from a local DSH home. A developer machine has one and reports
`tests=71 pass=71 fail=0 skipped=0`; a GitHub-hosted runner does not, so the same suite reports
`skipped=2`. Both are correct — they are simply not the same run.

- `test/transcript.test.mjs` — Markdown and Turn folding against a synthetic two-turn log **and** against the largest
  real `session.v4.jsonl.zstd` in the local Harness home. The real-log case asserts that every computed cut point
  addresses an event that actually exists (which is what `session.fork` requires), that the default export emits one
  `## Turn N` heading per folded turn, and that the compact export is strictly smaller.
- `test/host-routes.test.mjs` — the wire contract: route paths, methods, defaults, status codes, error envelopes, and
  the sibling-service read through a Proxy that throws on plain property access.
- `test/client-bundle.test.mjs` — the bundle parses, registers the factory id the loader demands, requires only
  `react`, declares both locale dictionaries with identical key sets, registers exactly the nine claimed entries, and
  renders each component with its documented props.

## Known limitations

- **The sidebar's content search needs the deployment patch above, and its first build needs an idle DSH.** While a
  turn is running, the index build can fail with `SESSION_QUERY_PERSISTENCE_FAILED`; retry when idle.
- **No whole-session delete.** DSH exposes no delete RPC for Sessions — only `workspace/archiveSession`. This plugin
  therefore does not remove conversations; use the shipped Archive action. Deleting the stored
  `session.v4.jsonl.zstd` by hand would also desynchronise the SQLite search index, so it is deliberately out.
- **Deleting a turn also deletes the reply to it.** Reasoning cannot be removed on its own: reasoning is part of the
  assistant step that produced it, and rewriting a stored event is impossible by design. "Regenerate" is the honest
  version of "delete the thinking process" — it drops the whole step and asks again.
- **Actions are disabled while a Session is running**, because forking a live conversation produces a child whose
  prefix ends mid-turn.
- **Turn actions appear only after the turn index loads** (one request per Session, cached for the page's lifetime).
  They render nothing until then rather than guessing a cut point.
- **A deep link only works in a browser that is already authenticated** to that Harness instance — it is a link into
  your local app, not a share link.
- **The automatic resend never retries itself.** `inputActions.submit()` carries no idempotency
  guarantee, so a rejected call may still have delivered the message and a second automatic call could send
  it twice. A rejection parks the payload in `failed` and shows a small bar above the composer with
  **Send again** and **Dismiss**; the text also stays in the draft, so pressing Enter by hand works too.
  Nothing is retried unless you ask.
- **A prefetched export is only a gesture bridge.** Hovering a row or opening the menu fetches the
  **default** mode ahead of the click — never `full`, and never all three modes — so the clipboard write
  happens inside the click's own focused gesture. Concurrent requests for the same Session and mode share
  one HTTP call, the cached export expires after 5 seconds, and it is dropped outright when the plugin
  knows the conversation moved on.
- **The clipboard needs a focused window.** `navigator.clipboard.writeText` rejects with `Document is not
  focused` when the app is in the background, and the `execCommand` fallback needs focus too. The plugin mitigates
  this in three ways: it prefetches on row hover and when the menu opens, so the write happens immediately after the
  click; it verifies the write by reading the clipboard back; and if the write is still refused, it reopens the export
  in a dialog with a retry button and a download button rather than losing it. A copy failure therefore never costs
  you the export.

## License

MIT
