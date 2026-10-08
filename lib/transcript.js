/**
 * Pure transcript rendering: stored Session events -> Markdown.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested against real `session.v4.jsonl.zstd` logs outside the Harness.
 *
 * The output is the *whole* conversation in log order — every turn heading, the
 * user's text, the assistant's reasoning and answer, every tool call with its
 * arguments, and every tool result — because that is what "copy this
 * conversation" means to a reader who wants to keep or paste the record.
 * `options.reasoning` and `options.tools` drop those sections for a compact
 * export.
 *
 * The event vocabulary handled here is the subset that carries human-visible
 * conversation material:
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
 * @param label - the disclosure summary.
 * @param body - the fenced body.
 * @returns a `<details>` element, or an empty string when the body is blank.
 */
function details(label, body) {
  if (body.trim() === '') return EMPTY;
  return `<details><summary>${label}</summary>\n\n${body}\n\n</details>`;
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
 * Collect the session's own metadata lines for the transcript header.
 *
 * @param header - the stored Session header.
 * @param extra - values discovered while folding the log.
 * @param extra.model - the last model id seen.
 * @param extra.turns - the number of turns folded.
 * @param extra.events - the number of events folded.
 * @param extra.exportedAt - the export timestamp in ms.
 * @returns Markdown bullet lines.
 */
function headerLines(header, extra) {
  const lines = [];
  if (header !== null && typeof header === 'object') {
    if (typeof header.id === 'string') lines.push(`- **Session**: \`${header.id}\``);
    if (typeof header.cwd === 'string' && header.cwd !== '') lines.push(`- **Workspace**: \`${header.cwd}\``);
    if (typeof header.createdAt === 'number') lines.push(`- **Created**: ${new Date(header.createdAt).toISOString()}`);
    if (typeof header.parentSession === 'string') lines.push(`- **Parent session**: \`${header.parentSession}\``);
    if (typeof header.agentPreset === 'string') lines.push(`- **Agent preset**: ${header.agentPreset}`);
  }
  if (typeof extra.model === 'string' && extra.model !== '') lines.push(`- **Last model**: \`${extra.model}\``);
  lines.push(`- **Turns**: ${String(extra.turns)}`);
  lines.push(`- **Events**: ${String(extra.events)}`);
  lines.push(`- **Exported**: ${new Date(extra.exportedAt).toISOString()}`);
  return lines;
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
 * @param input.options.reasoning - include reasoning blocks (default `true`).
 * @param input.options.tools - include tool calls, results and system text (default `true`).
 * @param input.options.meta - include the metadata header (default `true`).
 * @param input.options.generatedAt - export timestamp in ms (default `Date.now()`).
 * @returns the Markdown document.
 */
export function renderTranscript(input) {
  const { header, events, title } = input;
  const options = input.options ?? {};
  const includeReasoning = options.reasoning !== false;
  const includeTools = options.tools !== false;
  const includeMeta = options.meta !== false;
  const generatedAt = typeof options.generatedAt === 'number' ? options.generatedAt : Date.now();
  const list = Array.isArray(events) ? events : [];

  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Conversation';
  /** @type {string[]} */
  const body = [];
  let turns = 0;
  let lastModel = null;
  /** Whether the current turn section has emitted its heading yet. */
  let turnOpen = false;

  /**
   * Open a Turn section once, with a horizontal rule before every later one.
   *
   * @param turn - the Harness turn number.
   */
  const openTurn = (turn) => {
    if (turnOpen) return;
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
        if (!includeTools) break;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const args = argumentText(data.arguments);
        if (!turnOpen) openTurn(turns + 1);
        body.push(details(`Tool call · <code>${name}</code>`, indent(args)), EMPTY);
        break;
      }
      case 'tool/result': {
        if (!includeTools) break;
        const result = toolResultText(data);
        if (result.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push(details('Tool result', indent(result)), EMPTY);
        break;
      }
      case 'system/message': {
        if (!includeTools) break;
        const { text } = splitContent(data.content);
        if (text.trim() === '') break;
        if (!turnOpen) openTurn(turns + 1);
        body.push(details('System message', indent(text)), EMPTY);
        break;
      }
      case 'compaction/summary': {
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

  const out = [`# ${heading}`, EMPTY];
  if (includeMeta) out.push(...headerLines(header, { model: lastModel, turns, events: list.length, exportedAt: generatedAt }), EMPTY);
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
