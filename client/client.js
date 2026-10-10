/**
 * Browser half of the Conversation Toolkit bundle.
 *
 * Loaded by the Harness Client module system: this script only *registers* a
 * lazy factory (`window.__ModuleLoader__.load({ id, factory })`) whose id is the
 * package name. The factory returns the module exports, and `exports.apply` is
 * the Cordis plugin body.
 *
 * Only `react` is required from the browser module table. Per the shipped
 * plugin-authoring guidance (`references/practices.md`: "Do not require
 * `@deepseek-ai/dsh-client-ui-primitives`… a throwing component blanks your slot
 * entry") every control here is written locally and styled exclusively with
 * `--dsw-alias-*` theme tokens, so a renamed token degrades appearance instead
 * of breaking rendering.
 *
 * Capability map:
 *
 * | user request                  | extension point                                   |
 * |-------------------------------|---------------------------------------------------|
 * | copy a conversation as Markdown | `sidebar.workspaces.session.menu.item` / `.row.action` |
 * | copy a deep link                | `sidebar.workspaces.session.menu.item` / `.row.action` |
 * | edit a user message and resend  | `conversation.chat.turnTail` + edit dialog         |
 * | delete a turn / a reply         | `conversation.chat.turnTail`                       |
 * | search every conversation       | `conversation.input.dock` (above the composer card) |
 *
 * DSH has no transcript-write API — persistence is append-only and its events
 * are never rewritten — so every "change" is expressed as
 * `session.fork({ sessionId, atSeq })`, the platform's inclusive-prefix cut.
 * A rewrite therefore always produces a NEW Session and never touches the
 * source log.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-conversation-toolkit',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'conversation-toolkit';

    /** Document-relative route the Host half registers for Markdown exports. */
    const TRANSCRIPT_ROUTE = 'api/conversation-toolkit/transcript';
    /** Document-relative route the Host half registers for the Turn index. */
    const TURNS_ROUTE = 'api/conversation-toolkit/turns';
    /** Deep-link query key this plugin both writes and resolves. */
    const DEEP_LINK_KEY = 'dsh-session';

    // ───────────────────────────────────────────────────────────────────────
    // Styles
    // ───────────────────────────────────────────────────────────────────────

    const CSS = `
.ctk-menu-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:30px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.ctk-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ctk-menu-item:disabled{cursor:default;opacity:.5}
.ctk-menu-item svg{flex:none;width:14px;height:14px}
.ctk-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ctk-icon-button svg{width:15px;height:15px}
.ctk-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary)}
.ctk-icon-button:disabled{cursor:default;opacity:.4}
.ctk-action-row{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.ctk-action-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-right:4px}
.ctk-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ctk-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}
.ctk-dialog{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 64px);padding:18px;border-radius:var(--dsw-radius-panel,14px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 40px rgba(0,0,0,.28);font-size:13px;line-height:20px}
.ctk-dialog-title{font-size:15px;line-height:22px;font-weight:500}
.ctk-dialog-desc{color:var(--dsw-alias-label-secondary)}
.ctk-textarea{box-sizing:border-box;width:100%;min-height:150px;max-height:46vh;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
.ctk-textarea:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.ctk-dialog-footer{display:flex;justify-content:flex-end;gap:8px}
.ctk-button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.ctk-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ctk-button:disabled{cursor:default;opacity:.5}
.ctk-button[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.ctk-button[data-variant="danger"]{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.ctk-toast{position:fixed;left:50%;bottom:96px;z-index:1300;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:9px 14px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.24);font-size:13px;line-height:19px}
.ctk-toast[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
`;

    // ───────────────────────────────────────────────────────────────────────
    // Icons (14–16px stroked, currentColor)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Build one stroked icon element.
     *
     * @param children - the SVG path elements.
     * @returns the SVG element.
     */
    function strokeIcon(children) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false
        },
        children
      );
    }

    const IconCopy = () =>
      strokeIcon([
        h('rect', { key: 'a', x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6 }),
        h('path', { key: 'b', d: 'M10.5 5.5V3.6A1.6 1.6 0 0 0 8.9 2H3.6A1.6 1.6 0 0 0 2 3.6v5.3a1.6 1.6 0 0 0 1.6 1.6h1.9' })
      ]);

    const IconLink = () =>
      strokeIcon([
        h('path', { key: 'a', d: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.7.7' }),
        h('path', { key: 'b', d: 'M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.6 8.7a2.6 2.6 0 0 0 3.7 3.7l.7-.7' })
      ]);

    const IconSearch = () =>
      strokeIcon([
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4.3 }),
        h('path', { key: 'b', d: 'm10.4 10.4 3 3' })
      ]);

    const IconPencil = () =>
      strokeIcon([
        h('path', { key: 'a', d: 'M11.1 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.7l-3 .7.7-3z' }),
        h('path', { key: 'b', d: 'm9.9 3.8 2.3 2.3' })
      ]);

    const IconRefresh = () =>
      strokeIcon([
        h('path', { key: 'a', d: 'M13.4 8a5.4 5.4 0 1 1-1.6-3.8' }),
        h('path', { key: 'b', d: 'M13.6 2.4v3.1h-3.1' })
      ]);

    const IconTrash = () =>
      strokeIcon([
        h('path', { key: 'a', d: 'M2.8 4.2h10.4' }),
        h('path', { key: 'b', d: 'M6.4 4.2V3a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2' }),
        h('path', { key: 'c', d: 'M4.1 4.2l.6 8.2a1.3 1.3 0 0 0 1.3 1.2h4a1.3 1.3 0 0 0 1.3-1.2l.6-8.2' })
      ]);

    const IconClose = () =>
      strokeIcon([h('path', { key: 'a', d: 'm4 4 8 8M12 4l-8 8' })]);

    const IconDownload = () =>
      strokeIcon([
        h('path', { key: 'a', d: 'M8 2.6v7.6' }),
        h('path', { key: 'b', d: 'M4.9 7.2 8 10.3l3.1-3.1' }),
        h('path', { key: 'c', d: 'M2.9 12.6v.8a1 1 0 0 0 1 1h8.2a1 1 0 0 0 1-1v-.8' })
      ]);

    // ───────────────────────────────────────────────────────────────────────
    // Small observable store + clipboard/transport helpers
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Create a minimal replace-on-write observable snapshot store.
     *
     * @param initial - the initial snapshot.
     * @returns the store.
     */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        get: () => value,
        set(next) {
          value = next;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[conversation-toolkit] store listener threw:', error);
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      };
    }

    /**
     * Subscribe a component to a snapshot store without relying on React version specifics.
     *
     * @param store - the store to read.
     * @returns the current snapshot.
     */
    function useSnapshot(store) {
      const [value, setValue] = React.useState(store.get);
      React.useEffect(() => store.subscribe(() => setValue(store.get())), [store]);
      return value;
    }

    /** Overlay state: at most one dialog plus one toast, shared by every registration. */
    const overlayStore = createStore({ dialog: null, toast: null, copyFailure: null });

    /**
     * Reopen a failed copy as a dialog the user can retry from.
     *
     * The failure mode this exists for: `navigator.clipboard.writeText` rejects
     * with "Document is not focused" when the window is in the background, which
     * is easy to hit because the export is fetched first and copied afterwards.
     * Reopening the text means the retry happens on a fresh click in a focused
     * window, and the download button is a path that needs no clipboard at all.
     *
     * @param result - the failed `exportMarkdown` outcome, carrying the text.
     */
    function openCopyFailure(result) {
      overlayStore.set({
        ...overlayStore.get(),
        copyFailure: {
          title: result.title ?? result.sessionId ?? 'conversation',
          sessionId: result.sessionId ?? '',
          text: result.text,
          reason: result.detail ?? '',
          mode: result.mode ?? 'standard'
        }
      });
    }

    /**
     * Raise a transient toast.
     *
     * @param text - the message.
     * @param tone - `'info'` or `'error'`.
     */
    function notify(text, tone = 'info') {
      overlayStore.set({ ...overlayStore.get(), toast: { text, tone, seq: Date.now() + Math.random() } });
    }

    /**
     * Pending "resend into the fresh branch" payloads, keyed by child Session id.
     *
     * Each entry is a small state machine rather than a bare string, because the
     * submit is asynchronous and can fail after the draft was already accepted:
     *
     * | state        | meaning                                                  |
     * |--------------|----------------------------------------------------------|
     * | `pending`    | waiting for the composer to publish the draft             |
     * | `submitting` | the draft is in place and `submit()` has been called      |
     * | `failed`     | the submit failed for good; the text is kept for a retry  |
     *
     * Success is removal. The entry used to be deleted *before* the submit, so a
     * rejected submit lost the text with no way to recover it from the plugin.
     */
    const pendingResend = new Map();

    /** Delay before the single automatic retry of a failed send. */
    const RESEND_RETRY_DELAY_MS = 1500;

    /** How many submits one payload may make before the plugin stops trying. */
    const RESEND_MAX_ATTEMPTS = 2;

    /**
     * Decide what a failed automatic send should do next.
     *
     * Extracted so the bound is testable without a React renderer: a transient
     * rejection gets exactly one retry, and a second failure stops rather than
     * looping.
     *
     * @param attempts - how many submits have already been made.
     * @returns `'retry'` or `'give-up'`.
     */
    function resendAfterFailure(attempts) {
      return attempts < RESEND_MAX_ATTEMPTS ? 'retry' : 'give-up';
    }

    /**
     * Check whether the clipboard really holds `text`.
     *
     * @param text - the text that was just written.
     * @returns `true`/`false`, or `null` when reading is not permitted.
     */
    async function clipboardHolds(text) {
      // Reading is not always permitted; that is "cannot verify", not failure.
      try {
        if (typeof navigator.clipboard?.readText !== 'function') return null;
        return (await navigator.clipboard.readText()) === text;
      } catch {
        return null;
      }
    }

    /**
     * Copy text to the clipboard.
     *
     * The async Clipboard API needs a secure context AND a focused document, and
     * it rejects with "Document is not focused" otherwise — which is the normal
     * state for a background window, and is why a resolved promise alone is not
     * proof that anything was copied. The write is therefore verified when the
     * browser allows a read.
     *
     * @param text - the text to copy.
     * @returns `{ ok }` or `{ ok: false, reason }` naming what failed.
     */
    async function writeClipboard(text) {
      /** Every attempt's complaint, so the user sees why the whole path failed. */
      const failures = [];
      try {
        if (typeof navigator.clipboard?.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          const matches = await clipboardHolds(text);
          if (matches !== false) return { ok: true };
          failures.push('the browser reported success but the clipboard did not change');
        } else {
          failures.push('the async Clipboard API is unavailable');
        }
      } catch (error) {
        failures.push(describeError(error));
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.setAttribute('aria-hidden', 'true');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '0';
        area.style.width = '1px';
        area.style.height = '1px';
        area.style.padding = '0';
        area.style.border = 'none';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) return { ok: true };
        failures.push('the fallback copy command was refused');
      } catch (error) {
        console.error('[conversation-toolkit] clipboard write failed:', error);
        failures.push(describeError(error));
      }
      return { ok: false, reason: failures.join('; ') };
    }

    /**
     * Describe a failure for a toast.
     *
     * @param error - the thrown value.
     * @returns a short message.
     */
    function describeError(error) {
      if (error === null || error === undefined) return 'unknown error';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /**
     * Read one Session's Transcript Markdown from the Host half.
     *
     * @param sessionId - the Session to export.
     * @param options - render switches.
     * @returns the Markdown text and the Session title the Host echoed back.
     * @throws when the Host reports a business failure.
     */
    async function fetchTranscript(sessionId, options = {}) {
      const params = new URLSearchParams({ sessionId });
      // `mode` is the supported switch. It is stated explicitly rather than left
      // to the Host default so each action keeps its meaning if that ever changes.
      params.set('mode', options.mode ?? 'standard');
      const response = await fetch(`${TRANSCRIPT_ROUTE}?${params.toString()}`, { credentials: 'same-origin' });
      if (!response.ok) {
        let detail = `HTTP ${String(response.status)}`;
        try {
          const body = await response.json();
          if (typeof body?.error?.message === 'string') detail = body.error.message;
        } catch {
          /* the failure body is optional */
        }
        throw new Error(detail);
      }
      const encodedTitle = response.headers.get('x-conversation-toolkit-title');
      let title = sessionId;
      if (encodedTitle !== null && encodedTitle !== '') {
        try {
          title = decodeURIComponent(encodedTitle);
        } catch {
          /* a malformed header must not fail the export */
        }
      }
      return { text: await response.text(), title };
    }

    /**
     * Short-lived export cache, keyed by Session and mode.
     *
     * This exists so the clipboard write happens inside the click's own gesture.
     * `writeText` rejects with "Document is not focused" unless the window has
     * focus, and a multi-second export between the click and the write is long
     * enough for the user to look away — which is exactly how the copy "failed"
     * while the same code worked when driven programmatically.
     *
     * @type {Map<string, { text: string, title: string, at: number }>}
     */
    const transcriptCache = new Map();

    /** How long a prefetched export stays usable. */
    const TRANSCRIPT_CACHE_TTL_MS = 30000;

    /**
     * Compose the cache key for one export.
     *
     * @param sessionId - the Session.
     * @param mode - the export mode.
     * @returns the key.
     */
    function cacheKey(sessionId, mode) {
      return `${sessionId}\u0000${mode}`;
    }

    /**
     * Read a prefetched export, dropping it once it is stale.
     *
     * @param sessionId - the Session.
     * @param mode - the export mode.
     * @returns the cached export, or `undefined`.
     */
    function readCachedTranscript(sessionId, mode) {
      const key = cacheKey(sessionId, mode);
      const hit = transcriptCache.get(key);
      if (hit === undefined) return undefined;
      if (Date.now() - hit.at > TRANSCRIPT_CACHE_TTL_MS) {
        transcriptCache.delete(key);
        return undefined;
      }
      return hit;
    }

    /**
     * Store a prefetched export.
     *
     * @param sessionId - the Session.
     * @param mode - the export mode.
     * @param value - the fetched transcript.
     */
    function writeCachedTranscript(sessionId, mode, value) {
      transcriptCache.set(cacheKey(sessionId, mode), { ...value, at: Date.now() });
    }

    /**
     * Build a safe `.md` filename for one conversation.
     *
     * @param title - the Session title.
     * @param sessionId - the Session id, appended so two same-titled exports differ.
     * @returns the filename.
     */
    function markdownFilename(title, sessionId) {
      // Windows rejects a filename that ends in a dot or a space, and a title of
      // "." or ".." would name a directory, so the stem is stripped of both ends.
      const cleaned = String(title)
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(0, 80)
        .replace(/[.\s]+$/, '');
      const stem = cleaned === '' ? 'conversation' : cleaned;
      return `${stem} ${String(sessionId).replace(/^session-/, '').slice(0, 8)}.md`;
    }

    /**
     * Save one Markdown document through a Blob download.
     *
     * This path never touches the clipboard, so it works regardless of secure
     * context, focus, or how large the conversation is.
     *
     * @param filename - the suggested filename.
     * @param text - the document.
     * @returns whether the browser accepted the download.
     */
    function saveMarkdown(filename, text) {
      try {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return true;
      } catch (error) {
        console.error('[conversation-toolkit] download failed:', error);
        return false;
      }
    }

    /**
     * Read one Session's Turn index from the Host half.
     *
     * @param sessionId - the Session to index.
     * @returns the Turn records.
     * @throws when the Host reports a business failure.
     */
    async function fetchTurns(sessionId) {
      const response = await fetch(`${TURNS_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`);
      return body.value;
    }

    /**
     * Build the deep link for one Session.
     *
     * The Web shell never rewrites the document URL, so the query parameter this
     * plugin writes survives a boot and is resolved by {@link apply}.
     *
     * @param sessionId - the Session to address.
     * @returns the absolute URL.
     */
    function deepLink(sessionId) {
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set(DEEP_LINK_KEY, sessionId);
      return url.toString();
    }

    /**
     * Resolve one Turn from an index by the sequence a chat node anchors on.
     *
     * @param turns - the Turn records.
     * @param seq - the anchor sequence.
     * @returns the owning record, or `undefined`.
     */
    function turnAtSeq(turns, seq) {
      if (!Array.isArray(turns) || typeof seq !== 'number') return undefined;
      return turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === null || seq <= turn.endSeq));
    }

    // ───────────────────────────────────────────────────────────────────────
    // Per-session Turn cache (one Host read per Session, invalidated on demand)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Cache the Turn index per Session so a rendered turn does not refetch.
     *
     * @param services - the injected Host accessors.
     * @returns a reader plus an invalidator.
     */
    function createTurnCache(services) {
      const cache = new Map();
      return {
        read(sessionId) {
          const entry = cache.get(sessionId);
          if (entry !== undefined) return entry;
          const promise = services.fetchTurns(sessionId).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error: describeError(error) })
          );
          cache.set(sessionId, promise);
          return promise;
        },
        drop(sessionId) {
          cache.delete(sessionId);
        }
      };
    }

    /**
     * Subscribe a component to one Session's Turn index.
     *
     * Every failure path — a missing cache, a synchronous throw, a rejected
     * fetch — is folded into state: a slot entry that throws during render
     * abdicates its cell, so this hook must never throw.
     *
     * @param cache - the Turn cache, or `undefined` before services arrive.
     * @param sessionId - the Session to index.
     * @returns `{	turns, error }`.
     */
    function useTurns(cache, sessionId) {
      const [state, setState] = React.useState({ turns: null, error: null });
      React.useEffect(() => {
        if (cache === undefined || cache === null || typeof cache.read !== 'function') return undefined;
        let live = true;
        setState({ turns: null, error: null });
        Promise.resolve()
          .then(() => cache.read(sessionId))
          .then(
            (result) => {
              if (!live) return;
              if (result !== null && result !== undefined && result.ok === true) setState({ turns: result.value.turns, error: null });
              else setState({ turns: null, error: result?.error ?? 'unreadable' });
            },
            (error) => {
              if (live) setState({ turns: null, error: describeError(error) });
            }
          );
        return () => {
          live = false;
        };
      }, [cache, sessionId]);
      return state;
    }

    /**
     * A selector hook that yields nothing.
     *
     * Used when an optional standard hook prop is absent, so the component still
     * calls the same number of hooks on every render.
     *
     * @returns `undefined`.
     */
    function useNoValue() {
      return undefined;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Components — Session row (sidebar) actions
    // ───────────────────────────────────────────────────────────────────────

    /** A hook that never subscribes; used when an optional hook prop is absent. */
    function useNothing() {
      return null;
    }

    /**
     * Dismiss the owning Session menu, when the parent injected its state hook.
     *
     * @param useMenuOpenState - the optional injected hook.
     * @returns the close callback.
     */
    function useMenuCloser(useMenuOpenState) {
      const useMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState : useNothing;
      const state = useMenu();
      return React.useCallback(() => {
        if (Array.isArray(state) && typeof state[1] === 'function') state[1](false);
      }, [state]);
    }

    /**
     * Sidebar menu row: copy the whole conversation as Markdown.
     *
     * @param props - owner props plus the injected services.
     * @returns the menu row.
     */
    /**
     * Build one sidebar menu row that copies the conversation as Markdown.
     *
     * Two variants share this factory: the full record (every turn, the
     * assistant's reasoning, every tool call and result) and the compact one
     * (user text and answers only).
     *
     * @param options - the variant.
     * @param options.mode - the export mode this row copies.
     * @param options.labelKey - locale key for the row label.
     * @returns the menu row component.
     */
    function copyMarkdownMenuItem(options) {
      return function CopyMarkdownMenuItem({ sessionId, services, useMenuOpenState, t }) {
        const closeMenu = useMenuCloser(useMenuOpenState);
        const [busy, setBusy] = React.useState(false);
        // The menu only mounts its rows when it opens, so this is the earliest
        // safe moment to start the export the click will need.
        React.useEffect(() => {
          void services.prefetch(sessionId, { mode: options.mode });
        }, [services, sessionId]);
        const onSelect = React.useCallback(() => {
          closeMenu();
          setBusy(true);
          services
            .exportMarkdown(sessionId, { mode: options.mode })
            .then((result) => {
              if (result.ok) {
                notify(t('toast.markdownCopied', { n: String(result.chars) }));
                return;
              }
              if (result.code === 'copy' && typeof result.text === 'string') {
                openCopyFailure(result);
                return;
              }
              notify(t('toast.exportFailed', { detail: result.detail ?? '' }), 'error');
            })
            .finally(() => setBusy(false));
        }, [closeMenu, services, sessionId, t]);
        return h(
          'button',
          { type: 'button', role: 'menuitem', className: 'ctk-menu-item', disabled: busy, onClick: onSelect },
          h(IconCopy, null),
          h('span', null, busy ? t('menu.copyMarkdown.busy') : t(options.labelKey))
        );
      };
    }

    /** Menu row (order 500): the default export — the conversation plus tool names. */
    const CopyMarkdownMenuItem = copyMarkdownMenuItem({ mode: 'standard', labelKey: 'menu.copyMarkdown' });

    /** Menu row (order 505): everything in the log, with a sensitivity warning. */
    const CopyMarkdownFullMenuItem = copyMarkdownMenuItem({ mode: 'full', labelKey: 'menu.copyMarkdownFull' });

    /** Menu row (order 510): only the user text and the answers. */
    const CopyMarkdownBriefMenuItem = copyMarkdownMenuItem({ mode: 'brief', labelKey: 'menu.copyMarkdownBrief' });

    /**
     * Sidebar menu row: save the conversation as a `.md` file.
     *
     * A long conversation exports to well over a megabyte, and a download never
     * depends on the clipboard, the secure-context rules, or a paste target's
     * size limits — so this is the action that always works.
     *
     * @param props - owner props plus the injected services.
     * @returns the menu row.
     */
    function DownloadMarkdownMenuItem({ sessionId, services, useMenuOpenState, t }) {
      const closeMenu = useMenuCloser(useMenuOpenState);
      const [busy, setBusy] = React.useState(false);
      const onSelect = React.useCallback(() => {
        closeMenu();
        setBusy(true);
        services
          .downloadMarkdown(sessionId, { mode: 'standard' })
          .then((result) => {
            if (result.ok) {
              notify(t('toast.markdownSaved', { name: result.filename }));
              return;
            }
            notify(
              result.code === 'download' ? t('toast.downloadFailed') : t('toast.exportFailed', { detail: result.detail ?? '' }),
              'error'
            );
          })
          .finally(() => setBusy(false));
      }, [closeMenu, services, sessionId, t]);
      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'ctk-menu-item', disabled: busy, onClick: onSelect },
        h(IconDownload, null),
        h('span', null, busy ? t('menu.copyMarkdown.busy') : t('menu.downloadMarkdown'))
      );
    }

    /**
     * Sidebar menu row: copy a deep link that reopens this conversation.
     *
     * @param props - owner props plus the injected services.
     * @returns the menu row.
     */
    function CopyLinkMenuItem({ sessionId, services, useMenuOpenState, t }) {
      const closeMenu = useMenuCloser(useMenuOpenState);
      const onSelect = React.useCallback(() => {
        closeMenu();
        const link = deepLink(sessionId);
        writeClipboard(link).then((result) => {
          if (!result.ok) {
            notify(t('toast.copyFailedDetail', { detail: result.reason }), 'error');
            return;
          }
          services.rememberLink(sessionId, link);
          notify(t('toast.linkCopied'));
        });
      }, [closeMenu, services, sessionId, t]);
      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'ctk-menu-item', onClick: onSelect },
        h(IconLink, null),
        h('span', null, t('menu.copyLink'))
      );
    }

    /**
     * Sidebar row hover button: copy the conversation as Markdown.
     *
     * @param props - owner props plus the injected services.
     * @returns the hover button.
     */
    function CopyMarkdownRowButton({ sessionId, services, t }) {
      const [busy, setBusy] = React.useState(false);
      // Hovering the row is the user telling us they are about to copy.
      const onHover = React.useCallback(() => {
        void services.prefetch(sessionId, { mode: 'standard' });
      }, [services, sessionId]);
      const onSelect = React.useCallback(() => {
        setBusy(true);
        services
          .exportMarkdown(sessionId, { mode: 'standard' })
          .then((result) => {
            if (result.ok) {
              notify(t('toast.markdownCopied', { n: String(result.chars) }));
              return;
            }
            if (result.code === 'copy' && typeof result.text === 'string') {
              openCopyFailure(result);
              return;
            }
            notify(t('toast.exportFailed', { detail: result.detail ?? '' }), 'error');
          })
          .finally(() => setBusy(false));
      }, [services, sessionId, t]);
      return h(
        'button',
        {
          type: 'button',
          className: 'ctk-icon-button',
          // Stable hook so an automated probe can drive the real click path.
          'data-ctk-action': 'copy-markdown',
          title: t('menu.copyMarkdown'),
          'aria-label': t('menu.copyMarkdown'),
          disabled: busy,
          onMouseEnter: onHover,
          onFocus: onHover,
          onClick: onSelect
        },
        h(IconCopy, null)
      );
    }

    /**
     * Sidebar row hover button: copy the conversation deep link.
     *
     * @param props - owner props plus the injected services.
     * @returns the hover button.
     */
    function CopyLinkRowButton({ sessionId, services, t }) {
      const onSelect = React.useCallback(() => {
        const link = deepLink(sessionId);
        writeClipboard(link).then((result) => {
          if (!result.ok) {
            notify(t('toast.copyFailedDetail', { detail: result.reason }), 'error');
            return;
          }
          services.rememberLink(sessionId, link);
          notify(t('toast.linkCopied'));
        });
      }, [services, sessionId, t]);
      return h(
        'button',
        {
          type: 'button',
          className: 'ctk-icon-button',
          'data-ctk-action': 'copy-link',
          title: t('menu.copyLink'),
          'aria-label': t('menu.copyLink'),
          onClick: onSelect
        },
        h(IconLink, null)
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // Components — Turn actions inside the conversation
    // ───────────────────────────────────────────────────────────────────────

    /**
     * One Turn's action row: copy, edit-and-resend, regenerate, delete-from-here.
     *
     * Every destructive-looking action is a *fork*: it opens a new Session whose
     * log is the inclusive prefix the user chose, leaving this conversation
     * untouched, which is why the labels say "branch".
     *
     * @param props - the Turn owner props plus the injected services.
     * @returns the action row, or null while the Turn index is unknown.
     */
    function TurnActions(props) {
      const sessionId = props.sessionId;
      const seq = props.seq;
      const services = props.services;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const useStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoValue;
      // The session-status snapshot is empty until the Host list baseline
      // arrives, so the selector must tolerate `undefined` and a missing entry.
      const status = useStatus((map) =>
        map !== null && map !== undefined && typeof map.get === 'function' ? map.get(sessionId) : undefined
      );
      const turns = useTurns(services === null || services === undefined ? undefined : services.turnCache, sessionId);
      const turn = React.useMemo(() => turnAtSeq(turns.turns ?? [], seq), [turns.turns, seq]);
      const running = status !== null && status !== undefined && status.running === true;
      const [busy, setBusy] = React.useState(false);

      const guard = React.useCallback(() => {
        if (running) {
          notify(t('toast.sessionRunning'), 'error');
          return false;
        }
        if (turn === undefined || turn === null) {
          notify(t('toast.turnUnknown'), 'error');
          return false;
        }
        return true;
      }, [running, t, turn]);

      const onCopy = React.useCallback(() => {
        if (!guard()) return;
        const parts = [];
        parts.push(`## Turn ${String(turn.turn)}`);
        if (turn.user !== null && turn.user.text.trim() !== '') parts.push('### User', '', turn.user.text);
        if (turn.assistant.reasoning.trim() !== '') {
          parts.push('', '<details><summary>Thinking</summary>', '', turn.assistant.reasoning, '', '</details>');
        }
        if (turn.assistant.text.trim() !== '') parts.push('', '### Assistant', '', turn.assistant.text);
        writeClipboard(parts.join('\n')).then((result) =>
          notify(result.ok ? t('toast.turnCopied') : t('toast.copyFailedDetail', { detail: result.reason }), result.ok ? 'info' : 'error')
        );
      }, [guard, t, turn]);

      const onEdit = React.useCallback(() => {
        if (!guard()) return;
        overlayStore.set({
          ...overlayStore.get(),
          dialog: {
            kind: 'edit',
            sessionId,
            turn,
            text: turn.user?.text ?? '',
            origin: turn.user?.text ?? ''
          }
        });
      }, [guard, sessionId, turn]);

      const onRegenerate = React.useCallback(() => {
        if (!guard()) return;
        if (turn.dropSeq === null) {
          notify(t('toast.turnUnknown'), 'error');
          return;
        }
        overlayStore.set({
          ...overlayStore.get(),
          dialog: {
            kind: 'confirm',
            sessionId,
            title: t('confirm.regenerate.title'),
            description: t('confirm.regenerate.desc', { n: String(turn.turn) }),
            confirmLabel: t('confirm.regenerate.action'),
            danger: false,
            text: turn.user?.text ?? '',
            cutSeq: turn.dropSeq,
            resend: true
          }
        });
      }, [guard, sessionId, t, turn]);

      const onDelete = React.useCallback(() => {
        if (!guard()) return;
        if (turn.cutSeq === null) {
          notify(t('toast.turnUnknown'), 'error');
          return;
        }
        overlayStore.set({
          ...overlayStore.get(),
          dialog: {
            kind: 'confirm',
            sessionId,
            title: t('confirm.deleteTurn.title'),
            description: t('confirm.deleteTurn.desc', { n: String(turn.turn) }),
            confirmLabel: t('confirm.deleteTurn.action'),
            danger: true,
            cutSeq: turn.cutSeq,
            resend: false
          }
        });
      }, [guard, sessionId, t, turn]);

      if (turn === undefined || turn === null) return null;

      const button = (key, label, icon, onClick, disabled) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'ctk-icon-button',
            title: label,
            'aria-label': label,
            disabled: busy || disabled === true,
            onClick
          },
          h(icon, null)
        );

      return h(
        'div',
        { className: 'ctk-action-row', 'data-ctk': 'turn-actions' },
        h('span', { className: 'ctk-action-label' }, t('turn.label', { n: String(turn.turn) })),
        button('copy', t('turn.copy'), IconCopy, onCopy, false),
        button('edit', t('turn.edit'), IconPencil, onEdit, running),
        button('regen', t('turn.regenerate'), IconRefresh, onRegenerate, running),
        button('delete', t('turn.delete'), IconTrash, onDelete, running)
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // Components — overlay (edit dialog, confirm dialog, toast)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * The single `shell.overlay` entry: the edit/confirm dialog and the toast.
     *
     * @param props - the injected services and copy.
     * @returns the open dialog and toast, or null.
     */
    function ToolkitOverlay({ services, t }) {
      const state = useSnapshot(overlayStore);
      const dialog = state.dialog;
      const [text, setText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);

      React.useEffect(() => {
        setText(dialog?.text ?? '');
        setFailure(null);
        setBusy(false);
      }, [dialog]);

      const close = React.useCallback(() => {
        overlayStore.set({ ...overlayStore.get(), dialog: null });
      }, []);

      const closeCopyFailure = React.useCallback(() => {
        overlayStore.set({ ...overlayStore.get(), copyFailure: null });
      }, []);

      const copyFailure = state.copyFailure;

      /** Retry the clipboard inside this click's own focused gesture. */
      const retryCopy = React.useCallback(() => {
        const pending = overlayStore.get().copyFailure;
        if (pending === null || pending === undefined) return;
        setBusy(true);
        services.copyText(pending.text).then((result) => {
          setBusy(false);
          if (result.ok) {
            closeCopyFailure();
            notify(t('toast.markdownCopied', { n: String(pending.text.length) }));
            return;
          }
          setFailure(result.reason ?? '');
        });
      }, [closeCopyFailure, services, t]);

      /** Take the clipboard out of the picture entirely. */
      const retryDownload = React.useCallback(() => {
        const pending = overlayStore.get().copyFailure;
        if (pending === null || pending === undefined) return;
        const filename = markdownFilename(pending.title, pending.sessionId);
        if (services.saveText(filename, pending.text)) {
          closeCopyFailure();
          notify(t('toast.markdownSaved', { name: filename }));
          return;
        }
        setFailure(t('toast.downloadFailed'));
      }, [closeCopyFailure, services, t]);

      const toast = state.toast;
      React.useEffect(() => {
        if (toast === null || toast === undefined) return undefined;
        const timer = setTimeout(() => {
          const current = overlayStore.get();
          if (current.toast?.seq === toast.seq) overlayStore.set({ ...current, toast: null });
        }, toast.tone === 'error' ? 6000 : 2600);
        return () => clearTimeout(timer);
      }, [toast]);

      /**
       * Run the pending fork and, when asked, carry the text into the new branch.
       *
       * @param payload - what to fork and whether to resend.
       */
      const commit = React.useCallback(
        (payload) => {
          setBusy(true);
          setFailure(null);
          services
            .forkAndOpen(payload.sessionId, payload.cutSeq, payload.resend === true ? payload.text : null)
            .then((childId) => {
              close();
              notify(
                payload.resend === true ? t('toast.branchResent') : t('toast.branchCreated'),
                'info'
              );
              return childId;
            })
            .catch((error) => setFailure(describeError(error)))
            .finally(() => setBusy(false));
        },
        [close, services, t]
      );

      const dialogs = [];

      if (dialog?.kind === 'edit') {
        const unchanged = text === dialog.origin;
        dialogs.push(
          h(
            'div',
            { key: 'edit', className: 'ctk-overlay', role: 'presentation', onMouseDown: (event) => {
              if (event.target === event.currentTarget && !busy) close();
            } },
            h(
              'div',
              { className: 'ctk-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('edit.title') },
              h('div', { className: 'ctk-dialog-title' }, t('edit.title', { n: String(dialog.turn.turn) })),
              h('div', { className: 'ctk-dialog-desc' }, t('edit.desc')),
              h('textarea', {
                className: 'ctk-textarea',
                value: text,
                autoFocus: true,
                spellCheck: false,
                onChange: (event) => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape' && !busy) close();
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (!busy && !unchanged && text.trim() !== '') {
                      commit({ sessionId: dialog.sessionId, cutSeq: dialog.turn.cutSeq, text, resend: true });
                    }
                  }
                }
              }),
              failure !== null ? h('div', { className: 'ctk-dialog-desc', role: 'alert' }, failure) : null,
              h(
                'div',
                { className: 'ctk-dialog-footer' },
                h('button', { type: 'button', className: 'ctk-button', disabled: busy, onClick: close }, t('cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ctk-button',
                    'data-variant': 'primary',
                    disabled: busy || unchanged || text.trim() === '',
                    onClick: () => commit({ sessionId: dialog.sessionId, cutSeq: dialog.turn.cutSeq, text, resend: true })
                  },
                  busy ? t('working') : t('edit.action')
                )
              )
            )
          )
        );
      }

      if (dialog?.kind === 'confirm') {
        dialogs.push(
          h(
            'div',
            { key: 'confirm', className: 'ctk-overlay', role: 'presentation', onMouseDown: (event) => {
              if (event.target === event.currentTarget && !busy) close();
            } },
            h(
              'div',
              { className: 'ctk-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': dialog.title },
              h('div', { className: 'ctk-dialog-title' }, dialog.title),
              h('div', { className: 'ctk-dialog-desc' }, dialog.description),
              h('div', { className: 'ctk-dialog-desc' }, t('confirm.note')),
              failure !== null ? h('div', { className: 'ctk-dialog-desc', role: 'alert' }, failure) : null,
              h(
                'div',
                { className: 'ctk-dialog-footer' },
                h('button', { type: 'button', className: 'ctk-button', disabled: busy, onClick: close }, t('cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ctk-button',
                    'data-variant': dialog.danger === true ? 'danger' : 'primary',
                    disabled: busy,
                    onClick: () =>
                      commit({
                        sessionId: dialog.sessionId,
                        cutSeq: dialog.cutSeq,
                        text: dialog.text ?? '',
                        resend: dialog.resend === true
                      })
                  },
                  busy ? t('working') : dialog.confirmLabel
                )
              )
            )
          )
        );
      }

      if (copyFailure !== null && copyFailure !== undefined) {
        dialogs.push(
          h(
            'div',
            {
              key: 'copy-failure',
              className: 'ctk-overlay',
              role: 'presentation',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget && !busy) closeCopyFailure();
              }
            },
            h(
              'div',
              { className: 'ctk-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('copyFail.title') },
              h('div', { className: 'ctk-dialog-title' }, t('copyFail.title')),
              h('div', { className: 'ctk-dialog-desc' }, t('copyFail.desc', { detail: copyFailure.reason })),
              h('textarea', {
                className: 'ctk-textarea',
                value: copyFailure.text,
                readOnly: true,
                autoFocus: true,
                spellCheck: false,
                onFocus: (event) => event.target.select()
              }),
              failure !== null ? h('div', { className: 'ctk-dialog-desc', role: 'alert' }, failure) : null,
              h(
                'div',
                { className: 'ctk-dialog-footer' },
                h('button', { type: 'button', className: 'ctk-button', disabled: busy, onClick: closeCopyFailure }, t('cancel')),
                h('button', { type: 'button', className: 'ctk-button', disabled: busy, onClick: retryDownload }, t('copyFail.download')),
                h(
                  'button',
                  { type: 'button', className: 'ctk-button', 'data-variant': 'primary', disabled: busy, onClick: retryCopy },
                  busy ? t('working') : t('copyFail.copy')
                )
              )
            )
          )
        );
      }

      if (toast !== null && toast !== undefined) {
        dialogs.push(h('div', { key: 'toast', className: 'ctk-toast', 'data-tone': toast.tone, role: 'status' }, toast.text));
      }

      return dialogs.length === 0 ? null : h(React.Fragment, null, dialogs);
    }

    /**
     * Apply the pending "resend" payload once the fresh branch is mounted.
     *
     * The composer renders before its editor is bound, so the payload is applied
     * in two steps: fill the draft, then submit only after the published input
     * state really carries the text.
     *
     * @param props - the dock props carrying the live input state.
     * @returns nothing; this is a behaviour-only component.
     */
    function PendingResend({ sessionId, input, inputActions, t }) {
      const entry = pendingResend.get(sessionId);
      // A failed submit re-arms through this counter: the record is mutated in
      // place, so React needs an explicit reason to run the effect again.
      const [tick, setTick] = React.useState(0);

      // Step 1: publish the text into the composer.
      React.useEffect(() => {
        if (entry === undefined || entry.state !== 'pending') return;
        if (inputActions?.setDraft === undefined) return;
        inputActions.setDraft(entry.text);
      }, [entry, inputActions]);

      // Step 2: submit, but only once the composer really carries the text.
      React.useEffect(() => {
        if (entry === undefined || entry.state !== 'pending') return undefined;
        if (input?.draft !== entry.text) return undefined;
        if (typeof inputActions?.submit !== 'function') return undefined;

        entry.state = 'submitting';
        entry.attempts += 1;
        let timer = null;

        /**
         * Record a failed send.
         *
         * @param error - the thrown or rejected value.
         */
        const fail = (error) => {
          const detail = describeError(error);
          entry.error = detail;
          if (resendAfterFailure(entry.attempts) === 'retry') {
            entry.state = 'pending';
            notify(t('toast.resendRetrying', { detail }), 'error');
            timer = setTimeout(() => setTick((value) => value + 1), RESEND_RETRY_DELAY_MS);
            return;
          }
          entry.state = 'failed';
          notify(t('toast.resendFailed', { detail }), 'error');
        };

        try {
          const outcome = inputActions.submit();
          if (outcome !== null && outcome !== undefined && typeof outcome.then === 'function') {
            // The rejection is the case the old code missed entirely.
            outcome.then(() => pendingResend.delete(sessionId)).catch(fail);
          } else {
            pendingResend.delete(sessionId);
          }
        } catch (error) {
          fail(error);
        }
        return () => {
          if (timer !== null) clearTimeout(timer);
        };
      }, [entry, input, inputActions, sessionId, t, tick]);

      return null;
    }

    /**
     * Dock entry: the (invisible) resend plumbing for "edit and resend".
     *
     * The dock is the only seat that receives both the Session identity and the
     * composer's `input`/`inputActions`, so the pending resend is applied here;
     * it renders nothing, and therefore occupies no space above the composer.
     *
     * @param props - the dock owner props plus the injected services.
     * @returns `null` in every case.
     */
    function ComposerDock(props) {
      return h(PendingResend, {
        sessionId: props.sessionId,
        input: props.input,
        inputActions: props.inputActions,
        t: props.t
      });
    }

    // ───────────────────────────────────────────────────────────────────────
    // Plugin body
    // ───────────────────────────────────────────────────────────────────────

    /** Required services: the slot registry, the two Client controllers, and copy. */
    const inject = ['slots', 'sessions', 'uiWorkspace', 'locale'];

    /**
     * Client plugin body.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-conversation-toolkit';
        tag.dataset.pluginCss = 'dsh-plugin-conversation-toolkit/index.css';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'conversation-toolkit: stylesheet');

      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: {
              'menu.copyMarkdown': '复制为 Markdown（标准版）',
              'menu.copyMarkdownFull': '复制完整版（含思考与工具，可能含敏感信息）',
              'menu.copyMarkdownBrief': '复制简洁版（仅对话）',
              'menu.downloadMarkdown': '下载为 .md 文件（标准版）',
              'copyFail.title': '复制被浏览器拒绝',
              'copyFail.desc': '原因：{detail}。内容已备好，可在下面重新复制或直接下载。',
              'copyFail.copy': '重新复制',
              'copyFail.download': '下载为 .md',
              'menu.copyMarkdown.busy': '正在导出…',
              'menu.copyLink': '复制对话链接',
              'turn.label': '第 {n} 轮',
              'turn.copy': '复制本轮对话',
              'turn.edit': '编辑并重新发送',
              'turn.regenerate': '重新生成（丢弃该轮回答与思考）',
              'turn.delete': '删除此轮及之后的对话',
              'edit.title': '编辑第 {n} 轮的用户消息',
              'edit.desc': '保存后会从这一轮之前分叉出一个新会话，并把修改后的内容放进输入框重新发送。原会话不会被改动。',
              'edit.action': '分叉并重新发送',
              'confirm.regenerate.title': '重新生成这一轮',
              'confirm.regenerate.desc': '将丢弃第 {n} 轮助手的回答与思考过程，从该轮用户消息处重新提问。',
              'confirm.regenerate.action': '分叉并重新提问',
              'confirm.deleteTurn.title': '删除这一轮及之后的对话',
              'confirm.deleteTurn.desc': '第 {n} 轮及其之后的全部对话都不会出现在新会话里。',
              'confirm.deleteTurn.action': '分叉并删除',
              'confirm.note': 'DSH 的会话日志是只追加、不可改写的，因此这里的分叉只创建新会话，原会话保持原样，可随时回退。',
              'toast.linkCopied': '对话链接已复制',
              'toast.markdownCopied': '已复制 Markdown（{n} 字符）',
              'toast.markdownSaved': '已保存 {name}',
              'toast.downloadFailed': '浏览器拒绝了这次下载',
              'toast.exportFailed': '导出失败：{detail}',
              'toast.copyFailed': '复制失败，请重试',
              'toast.copyFailedDetail': '复制失败：{detail}',
              'toast.turnCopied': '本轮对话已复制',
              'toast.branchCreated': '已在新分支中打开',
              'toast.branchResent': '已在新分支中重新发送',
              'toast.sessionRunning': '该会话正在运行，请先停止再操作',
              'toast.turnUnknown': '这一轮的日志尚未就绪，请稍后重试',
              'toast.resendRetrying': '自动发送失败（{detail}），正在重试一次…',
              'toast.resendFailed': '自动发送失败（{detail}），内容已放入输入框，请按 Enter 发送',
              'close': '关闭',
              'cancel': '取消',
              'working': '处理中…'
            },
            en: {
              'menu.copyMarkdown': 'Copy as Markdown (standard)',
              'menu.copyMarkdownFull': 'Copy the full record (thinking + tools; may contain secrets)',
              'menu.copyMarkdownBrief': 'Copy the dialogue only',
              'menu.downloadMarkdown': 'Download as a .md file (standard)',
              'copyFail.title': 'The browser refused the copy',
              'copyFail.desc': 'Reason: {detail}. The export is ready below — copy it again, or download it.',
              'copyFail.copy': 'Copy again',
              'copyFail.download': 'Download .md',
              'menu.copyMarkdown.busy': 'Exporting…',
              'menu.copyLink': 'Copy conversation link',
              'turn.label': 'Turn {n}',
              'turn.copy': 'Copy this turn',
              'turn.edit': 'Edit and resend',
              'turn.regenerate': 'Regenerate (discard this reply and its thinking)',
              'turn.delete': 'Delete this turn and everything after',
              'edit.title': 'Edit the user message of turn {n}',
              'edit.desc': 'Saving branches a new Session off the point before this turn and puts the edited text back in the composer. The original conversation is left untouched.',
              'edit.action': 'Branch and resend',
              'confirm.regenerate.title': 'Regenerate this turn',
              'confirm.regenerate.desc': 'Discards the assistant reply and its reasoning for turn {n}, then asks again from that user message.',
              'confirm.regenerate.action': 'Branch and ask again',
              'confirm.deleteTurn.title': 'Delete this turn and everything after',
              'confirm.deleteTurn.desc': 'Turn {n} and every later turn are omitted from the new Session.',
              'confirm.deleteTurn.action': 'Branch and delete',
              'confirm.note': 'DSH session logs are append-only and never rewritten, so this branch only creates a new Session. The original stays exactly as it is and remains available.',
              'toast.linkCopied': 'Conversation link copied',
              'toast.markdownCopied': 'Markdown copied ({n} characters)',
              'toast.markdownSaved': 'Saved {name}',
              'toast.downloadFailed': 'The browser refused the download',
              'toast.exportFailed': 'Export failed: {detail}',
              'toast.copyFailed': 'Copy failed; try again',
              'toast.copyFailedDetail': 'Copy failed: {detail}',
              'toast.turnCopied': 'Turn copied',
              'toast.branchCreated': 'Opened in a new branch',
              'toast.branchResent': 'Resent in a new branch',
              'toast.sessionRunning': 'This Session is running; stop it first',
              'toast.turnUnknown': 'This turn is not readable yet; try again shortly',
              'toast.resendRetrying': 'Automatic send failed ({detail}); retrying once…',
              'toast.resendFailed': 'Automatic send failed ({detail}); the text is in the composer — press Enter',
              'close': 'Close',
              'cancel': 'Cancel',
              'working': 'Working…'
            }
          }),
        'conversation-toolkit: dictionaries'
      );

      const turnCache = createTurnCache({ fetchTurns });

      /** Services handed to every component through each registration's `inject`. */
      const services = {
        turnCache,
        openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
        rememberLink: (sessionId, link) => {
          lastLink.set(sessionId, link);
        },
        /**
         * Export one Session as Markdown and copy it.
         *
         * @param sessionId - the Session to export.
         * @returns a structured outcome the caller localizes.
         */
        async exportMarkdown(sessionId, options = {}) {
          const mode = options.mode ?? 'standard';
          try {
            const { text, title } = readCachedTranscript(sessionId, mode) ?? (await fetchTranscript(sessionId, { mode }));
            const copied = await writeClipboard(text);
            if (copied.ok) return { ok: true, chars: text.length, mode };
            // Hand the text back: the caller reopens it in a dialog whose buttons
            // run inside a fresh, focused gesture, instead of losing the export.
            return { ok: false, code: 'copy', detail: copied.reason, text, title, sessionId, mode };
          } catch (error) {
            return { ok: false, code: 'export', detail: describeError(error), mode };
          }
        },
        /**
         * Fetch one export ahead of the click, so the click can copy immediately.
         *
         * Failures are swallowed: a prefetch is an optimisation, and the real
         * action reports its own errors.
         *
         * @param sessionId - the Session to export.
         * @param options - render switches.
         * @returns whether a cached export is now available.
         */
        async prefetch(sessionId, options = {}) {
          const mode = options.mode ?? 'standard';
          if (readCachedTranscript(sessionId, mode) !== undefined) return true;
          try {
            writeCachedTranscript(sessionId, mode, await fetchTranscript(sessionId, { mode }));
            return true;
          } catch {
            return false;
          }
        },
        /**
         * Copy already-fetched text, for the focused retry in the fallback dialog.
         *
         * @param text - the text to copy.
         * @returns the clipboard outcome.
         */
        async copyText(text) {
          return writeClipboard(text);
        },
        /**
         * Save already-fetched text as a file.
         *
         * @param filename - the suggested filename.
         * @param text - the document.
         * @returns whether the browser accepted the download.
         */
        saveText(filename, text) {
          return saveMarkdown(filename, text);
        },
        /**
         * Export one Session as Markdown and save it as a file.
         *
         * @param sessionId - the Session to export.
         * @param options - render switches.
         * @returns a structured outcome the caller localizes.
         */
        async downloadMarkdown(sessionId, options = {}) {
          const mode = options.mode ?? 'standard';
          try {
            const { text, title } = await fetchTranscript(sessionId, { mode });
            const filename = markdownFilename(title, sessionId);
            return saveMarkdown(filename, text) ? { ok: true, chars: text.length, filename } : { ok: false, code: 'download' };
          } catch (error) {
            return { ok: false, code: 'export', detail: describeError(error) };
          }
        },
        /**
         * Fork one Session at an inclusive cut, open the child, and optionally resend.
         *
         * @param sessionId - the source Session.
         * @param cutSeq - inclusive last event to keep.
         * @param resendText - text to submit in the child, or null.
         * @returns the new Session id.
         */
        async forkAndOpen(sessionId, cutSeq, resendText) {
          if (typeof cutSeq !== 'number' || cutSeq < 0) throw new Error('the cut point is not available for this turn');
          const childId = await ctx.sessions.fork({ sessionId, atSeq: cutSeq, increaseTitle: true });
          if (typeof resendText === 'string' && resendText.trim() !== '') {
            pendingResend.set(childId, { text: resendText, state: 'pending', attempts: 0, error: null });
          }
          turnCache.drop(childId);
          ctx.uiWorkspace.openSession(childId);
          return childId;
        }
      };

      ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'conversation-toolkit.copy-markdown',
            order: 500,
            locale: NS,
            inject: () => services
          },
          CopyMarkdownMenuItem
        );
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'conversation-toolkit.copy-markdown-full',
            order: 505,
            locale: NS,
            inject: () => services
          },
          CopyMarkdownFullMenuItem
        );
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'conversation-toolkit.copy-markdown-brief',
            order: 510,
            locale: NS,
            inject: () => services
          },
          CopyMarkdownBriefMenuItem
        );
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'conversation-toolkit.download-markdown',
            order: 515,
            locale: NS,
            inject: () => services
          },
          DownloadMarkdownMenuItem
        );
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'conversation-toolkit.copy-link',
            order: 520,
            locale: NS,
            inject: () => services
          },
          CopyLinkMenuItem
        );
      });

      ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.row.action',
            id: 'conversation-toolkit.copy-markdown',
            order: 150,
            locale: NS,
            inject: () => services
          },
          CopyMarkdownRowButton
        );
        yield ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.row.action',
            id: 'conversation-toolkit.copy-link',
            order: 160,
            locale: NS,
            inject: () => services
          },
          CopyLinkRowButton
        );
      });

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'conversation-toolkit.turn-actions',
            order: 300,
            locale: NS,
            inject: () => services
          },
          TurnActions
        )
      );

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'conversation-toolkit.resend',
            order: -10,
            locale: NS,
            inject: () => services
          },
          ComposerDock
        )
      );

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'conversation-toolkit.dialogs',
            order: 20,
            locale: NS,
            inject: () => services
          },
          ToolkitOverlay
        )
      );



      // Resolve a deep link produced by "Copy conversation link": the Web shell
      // has no router and never touches the document URL, so a query parameter
      // this plugin writes survives a boot. `uiWorkspace.openSession` may run
      // before the Client catalogue is ready and before the shell's own
      // `restoreSelection` settles, so the open is repeated a few times.
      const pendingLink = new URL(window.location.href).searchParams.get(DEEP_LINK_KEY);
      if (pendingLink !== null && pendingLink !== '') {
        const open = () => {
          try {
            ctx.uiWorkspace.openSession(pendingLink);
          } catch (error) {
            console.error('[conversation-toolkit] deep link open failed:', error);
          }
        };
        ctx.effect(() => {
          open();
          const timers = [400, 1200, 2600, 5000].map((delay) => setTimeout(open, delay));
          return () => {
            for (const timer of timers) clearTimeout(timer);
          };
        }, 'conversation-toolkit: deep link');
      }
    }

    /** Last deep link written per Session, exposed for diagnostics in the console. */
    const lastLink = new Map();

    return {
      name: 'conversation-toolkit',
      inject,
      apply,
      // `internals` is the test seam: pure helpers the bundle tests exercise directly.
      internals: { deepLink, lastLink, resendAfterFailure }
    };
  }
});
