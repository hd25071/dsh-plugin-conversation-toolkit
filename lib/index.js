/**
 * Host half of the Conversation Toolkit bundle.
 *
 * The plugin adds no Session event type, mutates no stored log, and registers
 * no Remote namespace — every capability it exposes is a read over the mounted
 * `sessionQuery` service, delivered to the browser over two exact Fetch routes
 * that the Client half calls with a document-relative `fetch()`.
 *
 * That shape is deliberate:
 *
 * - **Reads only.** DSH persistence is append-only ("committed events are never
 *   rewritten"), so an editing feature cannot be a write. The Client half turns
 *   user intent into `session.fork({ sessionId, atSeq })`, the platform's only
 *   transcript-cut primitive, which always creates a *new* Session and never
 *   touches the source.
 * - **No Harness imports.** A third-party bundle is resolved by Node from its
 *   own real path, so `import '@deepseek-ai/...'` fails with
 *   `ERR_MODULE_NOT_FOUND` and lands the row in the plugin page's error state.
 *   Services are reached through `ctx.get(key)` instead.
 *
 * @module dsh-plugin-conversation-toolkit
 */

import { renderTranscript, titleFromEvents } from './transcript.js';
import { analyzeTurns } from './turns.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'conversation-toolkit';

/** The exact Fetch routes require the connection service. */
export const inject = ['connection'];

/** Absolute registration path of the Markdown/JSON transcript route. */
export const TRANSCRIPT_PATH = '/api/conversation-toolkit/transcript';

/** Absolute registration path of the Turn-index route. */
export const TURNS_PATH = '/api/conversation-toolkit/turns';

/**
 * Build one JSON response.
 *
 * @param body - the serializable payload.
 * @param status - HTTP status code.
 * @returns the response, marked uncacheable because transcripts are live data.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

/**
 * Build the shared business-failure body.
 *
 * @param code - routable failure code.
 * @param message - developer-facing description.
 * @param status - HTTP status code.
 * @returns the response.
 */
function failure(code, message, status) {
  return json({ ok: false, error: { code, message } }, status);
}

/**
 * Read one service without the `inject` requirement.
 *
 * Cordis resolves a service by walking the plugin's ancestor fibers, and a
 * service provided by a *sibling* fiber is not reachable that way: plain
 * property access throws `cannot get property "<name>" without inject` (proven
 * against the shipped runtime). `ctx.get(name)` is the documented reader for
 * exactly this case — "read a service from the store without the inject
 * requirement" — and returns `undefined` for an absent service instead of
 * throwing.
 *
 * Both readers are attempted so the plugin keeps working if the access path
 * changes, and this function never throws: a route must answer with a
 * diagnosable status rather than rejecting.
 *
 * @param ctx - the plugin context.
 * @param key - the service name.
 * @returns the service value, or `undefined`.
 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* fall through to the property reader */
  }
  try {
    const value = Reflect.get(ctx, key);
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Read a boolean query parameter, accepting only the canonical spellings.
 *
 * @param params - the request's search parameters.
 * @param key - parameter name.
 * @param fallback - value used when the parameter is absent.
 * @returns the parsed boolean.
 */
function boolParam(params, key, fallback) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

/**
 * Load one logical Session through the query service.
 *
 * @param query - the session-query service.
 * @param sessionId - Session to read.
 * @returns the header and its full event log.
 * @throws {Error} with a `code` property when the Session is unknown.
 */
async function loadSession(query, sessionId) {
  let loaded;
  try {
    loaded = await query.readSession(sessionId);
  } catch (error) {
    const code = error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'session-not-found' : 'session-unreadable';
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.code = code;
    throw wrapped;
  }
  return loaded;
}

/**
 * Answer the transcript route.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the Markdown document or its JSON envelope.
 */
async function transcriptResponse(request, ctx) {
  const query = serviceOf(ctx, 'sessionQuery');
  if (query === undefined) return failure('service-unavailable', 'the sessionQuery service is not mounted in this profile', 503);
  const params = new URL(request.url).searchParams;
  const sessionId = params.get('sessionId') ?? '';
  if (sessionId === '') return failure('bad-request', 'sessionId is required', 400);

  let loaded;
  try {
    loaded = await loadSession(query, sessionId);
  } catch (error) {
    return failure(error.code, error.message, error.code === 'session-not-found' ? 404 : 500);
  }

  // A complete export is the default: this plugin exists to copy the whole record.
  const options = {
    reasoning: boolParam(params, 'reasoning', true),
    tools: boolParam(params, 'tools', true),
    meta: boolParam(params, 'meta', true)
  };
  const title = titleFromEvents(loaded.events);

  if (params.get('format') === 'json') {
    const markdown = renderTranscript({ header: loaded.session, events: loaded.events, title, options });
    return json({ ok: true, value: { sessionId, title: title ?? null, markdown, eventCount: loaded.events.length } });
  }

  const markdown = renderTranscript({ header: loaded.session, events: loaded.events, title, options });
  return new Response(markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      // The Client half reads this to name the downloaded file without a second call.
      'x-conversation-toolkit-title': encodeURIComponent(title ?? sessionId)
    }
  });
}

/**
 * Answer the Turn-index route.
 *
 * @param request - the incoming request.
 * @param ctx - the plugin context.
 * @returns the JSON envelope with one record per Turn.
 */
async function turnsResponse(request, ctx) {
  const query = serviceOf(ctx, 'sessionQuery');
  if (query === undefined) return failure('service-unavailable', 'the sessionQuery service is not mounted in this profile', 503);
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
  if (sessionId === '') return failure('bad-request', 'sessionId is required', 400);

  let loaded;
  try {
    loaded = await loadSession(query, sessionId);
  } catch (error) {
    return failure(error.code, error.message, error.code === 'session-not-found' ? 404 : 500);
  }

  const turns = analyzeTurns(loaded.events);
  return json({
    ok: true,
    value: {
      sessionId,
      title: titleFromEvents(loaded.events) ?? null,
      eventCount: loaded.events.length,
      turns
    }
  });
}

/**
 * Register the two exact Fetch routes and return their cleanup.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const connection = serviceOf(ctx, 'connection');
  if (connection === undefined) return;
  connection.fetch.register({
    path: TRANSCRIPT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await transcriptResponse(request, ctx);
      if (request.method === 'GET') return response;
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
  });
  connection.fetch.register({
    path: TURNS_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await turnsResponse(request, ctx);
      if (request.method === 'GET') return response;
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
  });
}
