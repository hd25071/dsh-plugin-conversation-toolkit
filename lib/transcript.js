/**
 * Pure transcript rendering: stored Session events -> Markdown.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested against real `session.v4.jsonl.zstd` logs outside the Harness.
 *
 * ## Export modes
 *
 * A transcript can carry material that must not leave the machine by accident:
 * thinking often quotes private context, tool-call arguments carry absolute
 * paths and sometimes tokens, and tool results are frequently file dumps or
 * command output. The default is therefore the *narrow* one, and the widest
 * mode says so in the document itself.
 *
 * | mode       | user + assistant | thinking | tool names | tool args/results | system text | metadata |
 * |------------|------------------|----------|------------|-------------------|-------------|----------|
 * | `brief`    | yes              | no       | no         | no                | no          | yes      |
 * | `standard` | yes              | no       | yes        | no                | no          | yes      |
 * | `full`     | yes              | yes      | yes        | yes               | yes         | yes      |
 *
 * `standard` is the default: it is the conversation plus the names of the tools
 * that ran, which is what makes a transcript readable without exposing the
 * payloads.
 *
 * ## Event vocabulary
 *
 * | event type           | carries                                             |
 * |----------------------|-----------------------------------------------------|
 * | `turn/start`         | the turn boundary that opens a `## Turn N` section   |
 * | `user/message`       | one user input (`data.content[]`)                    |
 * | `assistant/message`  | one settled model step (`data.content[]`/`data.blocks[]`) |
 * | `tool/call`          | a tool invocation (`data.name`, `data.arguments`)    |
 * | `tool/result`        | its result (`data.message.content[]`)                |
 * | `system/message`     | system prompt / injected developer text              |
 * | `compaction/summary` | a compaction summary standing in for older history   |
 * | `session/title`      | the folded title, used as the document heading       |
 *
 * Every other event type is skipped: unknown vocabulary must never break an
 * export, because the Harness adds event types between releases.
 *
 * @module dsh-plugin-conversation-toolkit/transcript
 */

/** Marker used when a block carries no readable text. */
const EMPTY = '';

/** The export modes, widest last. */
export const EXPORT_MODES = ['brief', 'standard', 'full'];

/** The mode used when a caller does not choose one. */
export const DEFAULT_EXPORT_MODE = 'standard';

/**
 * Escape text that is about to be placed inside an HTML fragment.
 *
 * The document is Markdown, but `<details>`/`<code>` are emitted as raw HTML, so
 * any *dynamic* text placed inside them must be escaped: a tool name, a session
 * title or a file path is attacker-influenced in the sense that a model or a
 * tool can produce it, and an unescaped `<` would inject markup into a document
 * the user is about to share.
 *
 * @param value - the raw text.
 * @returns the text safe to interpolate into HTML.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render text as a Markdown code span.
 *
 * A code span is literal: HTML entities are NOT decoded inside it, so escaping
 * there would print `&lt;` instead of `<`. What has to be neutralised instead is
 * the backtick that would close the span early.
 *
 * @param value - the raw text.
 * @returns the code span.
 */
export function codeSpan(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

/**
 * Read the text of one content block from any of the shapes the Harness writes.
 *
 * Blocks arrive either already folded (`{ type: 'text', text }`) or straight
 * from a provider stream (`{ kind: 'reasoning', text }`), so both discriminators
 * are accepted.
 *
 * @param block - one content block.
 * @returns the block's text, or an empty string when it carries none.
 */
export function blockText(block) {
  if (typeof block === 'string') return block;
  if (block === null || typeof block !== 'object') return EMPTY;
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return EMPTY;
}

/**
 * Classify one content block.
 *
 * @param block - one content block.
 * @returns `'reasoning'`, `'tool-call'`, `'image'`, `'file'`, or `'text'`.
 */
export function blockKind(block) {
  if (block === null || typeof block !== 'object') return 'text';
  const raw = typeof block.kind === 'string' ? block.kind : typeof block.type === 'string' ? block.type : 'text';
  switch (raw) {
    case 'reasoning':
    case 'thinking':
    case 'redacted-reasoning':
      return 'reasoning';
    case 'tool-call':
    case 'tool_use':
    case 'tool-use':
      return 'tool-call';
    case 'image':
      return 'image';
    case 'file':
      return 'file';
    default:
      return 'text';
  }
}

/**
 * Split a block list into the buckets a transcript renders separately.
 *
 * @param content - the block array of one event payload.
 * @returns the joined text, joined reasoning, and the non-text block kinds seen.
 */
export function splitContent(content) {
  const text = [];
  const reasoning = [];
  const other = [];
  if (!Array.isArray(content)) return { text: EMPTY, reasoning: EMPTY, other };
  for (const block of content) {
    const kind = blockKind(block);
    if (kind === 'reasoning') {
      const value = blockText(block);
      if (value.trim() !== '') reasoning.push(value);
      continue;
    }
    if (kind === 'text') {
      const value = blockText(block);
      if (value !== '') text.push(value);
      continue;
    }
    other.push(kind);
  }
  return { text: text.join('\n\n').trim(), reasoning: reasoning.join('\n\n').trim(), other };
}

/**
 * Render one Markdown disclosure element.
 *
 * @param labelHtml - the summary, already escaped where dynamic.
 * @param body - the fenced body.
 * @returns a `<details>` element, or an empty string when the body is blank.
 */
function details(labelHtml, body) {
  if (body.trim() === '') return EMPTY;
  return `<details><summary>${labelHtml}</summary>\n\n${body}\n\n</details>`;
}

/**
 * Indent every line of a block by four spaces so it survives Markdown layout.
 *
 * @param value - the raw text.
 * @returns the indented text.
 */
function indent(value) {
  return value
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n');
}

/**
 * Render a tool-call argument string, pretty-printing it when it is JSON.
 *
 * @param raw - `data.arguments`, which the Harness stores as a JSON string.
 * @returns the renderable argument text.
 */
function argumentText(raw) {
  if (typeof raw !== 'string') return raw === undefined || raw === null ? EMPTY : JSON.stringify(raw, null, 2);
  const trimmed = raw.trim();
  if (trimmed === '') return EMPTY;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/**
 * Render one tool result payload.
 *
 * @param data - the `tool/result` payload.
 * @returns the result text.
 */
function toolResultText(data) {
  if (data === null || typeof data !== 'object') return EMPTY;
  const split = splitContent(data.message?.content);
  if (split.text !== EMPTY) return split.text;
  if (typeof data.content === 'string') return data.content;
  return EMPTY;
}

/**
 * Resolve the requested export mode.
 *
 * `options.mode` wins; the legacy `reasoning`/`tools` booleans are still honoured
 * so an older caller keeps its meaning, and anything unrecognised falls back to
 * the narrow default rather than to the widest mode.
 *
 * @param options - the render switches.
 * @returns one of {@link EXPORT_MODES}.
 */
function resolveMode(options) {
  const requested = options.mode;
  if (requested !== undefined && requested !== null) {
    // An explicit mode is honoured only when it is one we know. Anything else is
    // the narrow default, and the legacy switches below may only narrow it
    // further: an illegal mode must never be widened into `full`.
    return EXPORT_MODES.includes(requested) ? requested : DEFAULT_EXPORT_MODE;
  }
  const { reasoning, tools } = options;
  if (reasoning === undefined && tools === undefined) return DEFAULT_EXPORT_MODE;
  // The old explicit whole-record request is still honoured...
  if (reasoning === true && tools === true) return 'full';
  // ...but a mixed pair is an intersection, and no mode is both. Fall back to the
  // narrow default and let the capability flags drop whatever was excluded.
  return DEFAULT_EXPORT_MODE;
}

/**
 * Human-readable description of what a mode leaves out, for the document header.
 *
 * @param mode - the resolved mode.
 * @returns the description.
 */
function modeDescription(mode) {
  switch (mode) {
    case 'brief':
      return 'brief (user messages and answers only)';
    case 'full':
      return 'full (everything in the log)';
    default:
      return 'standard (adds tool names; no thinking, arguments or results)';
  }
}

/**
 * Collect the session's own metadata lines for the transcript header.
 *
 * @param header - the stored Session header.
 * @param extra - values discovered while folding the log.
 * @param extra.model - the last model id seen.
 * @param extra.turns - the number of turns folded.
 * @param extra.events - the number of events folded.
 * @param extra.exportedAt - the export timestamp in ms.
 * @param extra.mode - the resolved export mode.
 * @param extra.localPaths - include the workspace path and parent Session id.
 * @returns Markdown bullet lines.
 */
function headerLines(header, extra) {
  const lines = [];
  if (header !== null && typeof header === 'object') {
    if (typeof header.id === 'string') lines.push(`- **Session**: ${codeSpan(header.id)}`);
    // The workspace path and the parent Session id are local-path metadata: they
    // name the machine's directory layout and another conversation, so they are
    // only written by the mode that already warns about local paths.
    if (extra.localPaths === true && typeof header.cwd === 'string' && header.cwd !== '') {
      lines.push(`- **Workspace**: ${codeSpan(header.cwd)}`);
    }
    if (typeof header.createdAt === 'number') lines.push(`- **Created**: ${new Date(header.createdAt).toISOString()}`);
    if (extra.localPaths === true && typeof header.parentSession === 'string') {
      lines.push(`- **Parent session**: ${codeSpan(header.parentSession)}`);
    }
    // Plain Markdown text, not a code span: entities are decoded here, so escaping
    // is what keeps a raw `<` from becoming live HTML.
    if (typeof header.agentPreset === 'string') lines.push(`- **Agent preset**: ${escapeHtml(header.agentPreset)}`);
  }
  if (typeof extra.model === 'string' && extra.model !== '') lines.push(`- **Last model**: ${codeSpan(extra.model)}`);
  lines.push(`- **Turns**: ${String(extra.turns)}`);
  lines.push(`- **Events**: ${String(extra.events)}`);
  lines.push(`- **Export**: ${modeDescription(extra.mode)}`);
  lines.push(`- **Exported**: ${new Date(extra.exportedAt).toISOString()}`);
  // The residual risk no mode can remove: the user's own words are the document.
  lines.push('- **Careful**: your own messages are included verbatim and may contain secrets.');
  return lines;
}

/**
 * The notice a `full` export carries, because it is the one mode that can leak.
 *
 * @returns Markdown blockquote lines.
 */
function fullModeWarning() {
  return [
    '> [!WARNING]',
    '> This export contains **thinking, tool-call arguments and tool results**.',
    '> Those routinely carry API tokens, credentials, absolute local paths, file',
    '> contents and command output. Read it before sharing it.',
    '>',
    '> Your own messages are included verbatim in every mode and can contain',
    '> secrets too — the narrower modes only remove what the agent added.'
  ];
}

/**
 * Render a stored Session log as one Markdown document covering the whole
 * conversation.
 *
 * @param input - the transcript source.
 * @param input.header - the stored Session header (may be `undefined`).
 * @param input.events - the replay-validated event log, ascending by `seq`.
 * @param input.title - the folded Session title, when one exists.
 * @param input.options - render switches.
 * @param input.options.mode - `'brief'`, `'standard'` or `'full'` (default `'standard'`).
 * @param input.options.reasoning - legacy switch, superseded by `mode`.
 * @param input.options.tools - legacy switch, superseded by `mode`.
 * @param input.options.meta - include the metadata header (default `true`).
 * @param input.options.generatedAt - export timestamp in ms (default `Date.now()`).
 * @returns the Markdown document.
 */
export function renderTranscript(input) {
  const { header, events, title } = input;
  const options = input.options ?? {};
  const mode = resolveMode(options);
  const includeMeta = options.meta !== false;
  // The mode sets the ceiling; the legacy switches may only lower it. `true` is a
  // permission, never a demand, which is what keeps `reasoning=false` from
  // smuggling reasoning into a tool-enabled export and `tools=false` from
  // smuggling payloads into a reasoning-enabled one.
  const allowReasoning = options.reasoning !== false;
  const allowTools = options.tools !== false;
  const includeReasoning = mode === 'full' && allowReasoning;
  const includeToolPayloads = mode === 'full' && allowTools;
  const includeToolNames = mode !== 'brief' && allowTools;
  const includeSystem = mode === 'full' && allowTools;
  // Internal summaries stand in for history the user never wrote; they are only
  // ever part of the mode that warns about everything it carries.
  const includeCompaction = mode === 'full';
  const includeLocalPaths = mode === 'full';
  const generatedAt = typeof options.generatedAt === 'number' ? options.generatedAt : Date.now();
  const list = Array.isArray(events) ? events : [];

  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Conversation';
  /** @type {string[]} */
  const body = [];
  let turns = 0;
  let lastModel = null;
  /** Whether the current turn section has emitted its heading yet. */
  let turnOpen = false;
  /** Tool names seen in the open turn, flushed as one line when the turn closes. */
  const turnTools = [];

  /**
   * Emit the collected tool names for the turn that is ending.
   *
   * Standard mode names the tools without their payloads, so the names are
   * gathered per turn and written once, as a single readable line.
   */
  const flushTools = () => {
    if (turnTools.length === 0) return;
    const unique = [...new Set(turnTools)];
    body.push(`**Tools used**: ${unique.map((name) => codeSpan(name)).join(', ')}`, EMPTY);
    turnTools.length = 0;
  };

  /**
   * Open a Turn section once, with a horizontal rule before every later one.
   *
   * @param turn - the Harness turn number.
   */
  const openTurn = (turn) => {
    if (turnOpen) return;
    flushTools();
    if (turns > 0) body.push('---', EMPTY);
    turns += 1;
    body.push(`## Turn ${String(turn)}`, EMPTY);
    turnOpen = true;
  };

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue;
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start': {
        if (typeof data.turn === 'number') {
          flushTools();
          turnOpen = false;
          openTurn(data.turn);
        }
        break;
      }
      case 'user/message': {
        const { text } = splitContent(data.content);
        if (text.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push('### User', EMPTY, text, EMPTY);
        break;
      }
      case 'assistant/message': {
        const content = splitContent(data.content);
        const blocks = splitContent(data.blocks);
        const answer = content.text.trim() !== '' ? content.text : blocks.text;
        const thoughts = content.reasoning.trim() !== '' ? content.reasoning : blocks.reasoning;
        if (typeof data.model === 'string') lastModel = data.model;
        if (answer.trim() === '' && thoughts.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        if (includeReasoning && thoughts.trim() !== '') body.push('#### Thinking', EMPTY, thoughts, EMPTY);
        if (answer.trim() !== '') body.push('### Assistant', EMPTY, answer, EMPTY);
        break;
      }
      case 'tool/call': {
        if (!includeToolNames) break;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        if (!turnOpen) openTurn(turns + 1);
        if (includeToolPayloads) {
          const args = argumentText(data.arguments);
          body.push(details(`Tool call · <code>${escapeHtml(name)}</code>`, indent(args)), EMPTY);
        } else {
          // The name only: gathered so the turn carries one summary line.
          turnTools.push(name);
        }
        break;
      }
      case 'tool/result': {
        if (!includeToolPayloads) break;
        const result = toolResultText(data);
        if (result.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push(details('Tool result', indent(result)), EMPTY);
        break;
      }
      case 'system/message': {
        if (!includeSystem) break;
        const { text } = splitContent(data.content);
        if (text.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push(details('System message', indent(text)), EMPTY);
        break;
      }
      case 'compaction/summary': {
        if (!includeCompaction) break;
        const { text } = splitContent(data.summary);
        if (text.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push('### Compacted history', EMPTY, text, EMPTY);
        break;
      }
      default:
        break;
    }
  }
  flushTools();

  const out = [`# ${heading}`, EMPTY];
  if (includeMeta) {
    out.push(
      ...headerLines(header, {
        model: lastModel,
        turns,
        events: list.length,
        exportedAt: generatedAt,
        mode,
        localPaths: includeLocalPaths
      }),
      EMPTY
    );
  }
  if (mode === 'full') out.push(...fullModeWarning(), EMPTY);
  out.push(...body);

  // Collapse trailing blank lines so the document ends with exactly one newline.
  while (out.length > 0 && out[out.length - 1] === EMPTY) out.pop();
  return `${out.join('\n')}\n`;
}

/**
 * Read the title out of a session event log, for callers that have no folded title.
 *
 * @param events - the stored event log.
 * @returns the most recent `session/title` value, or `undefined`.
 */
export function titleFromEvents(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.trim() !== '') return title.trim();
  }
  return undefined;
}
