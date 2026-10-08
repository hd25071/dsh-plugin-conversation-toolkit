/**
 * Pure transcript rendering: stored Session events -> Markdown.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit-tested against real `session.v4.jsonl.zstd` logs outside the Harness.
 *
 * The event vocabulary handled here is the subset that carries human-visible
 * conversation text:
 *
 * | event type          | carries                                            |
 * |---------------------|----------------------------------------------------|
 * | `session/title`     | the folded Session title                           |
 * | `user/message`      | one user turn input (`data.content[]`)             |
 * | `assistant/message` | one settled model step (`data.content[]`/`blocks[]`)|
 * | `tool/call`         | a tool invocation (`data.name`, `data.arguments`)  |
 * | `tool/result`       | its result (`data.message.content[]`)              |
 * | `system/message`    | system prompt / injected developer text            |
 * | `compaction/summary`| a compaction summary standing in for older history |
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
 * Split a block list into the three buckets a transcript renders separately.
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
 * Render one Markdown blockquote-safe fence.
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
 * Render one tool result payload.
 *
 * @param data - the `tool/result` payload.
 * @returns the result text.
 */
function toolResultText(data) {
  if (data === null || typeof data !== 'object') return EMPTY;
  return splitContent(data.message?.content).text;
}

/**
 * Collect the session's own metadata lines for the transcript header.
 *
 * @param header - the stored Session header.
 * @returns Markdown bullet lines.
 */
function headerLines(header) {
  const lines = [];
  if (header === null || typeof header !== 'object') return lines;
  if (typeof header.id === 'string') lines.push(`- **Session**: \`${header.id}\``);
  if (typeof header.cwd === 'string' && header.cwd !== '') lines.push(`- **Workspace**: \`${header.cwd}\``);
  if (typeof header.createdAt === 'number') lines.push(`- **Created**: ${new Date(header.createdAt).toISOString()}`);
  if (typeof header.parentSession === 'string') lines.push(`- **Parent session**: \`${header.parentSession}\``);
  if (typeof header.agentPreset === 'string') lines.push(`- **Agent preset**: ${header.agentPreset}`);
  return lines;
}

/**
 * Render a stored Session log as one Markdown document.
 *
 * @param input - the transcript source.
 * @param input.header - the stored Session header (may be `undefined`).
 * @param input.events - the replay-validated event log, ascending by `seq`.
 * @param input.title - the folded Session title, when one exists.
 * @param input.options - render switches.
 * @param input.options.reasoning - include reasoning blocks (default `false`).
 * @param input.options.tools - include tool calls and results (default `false`).
 * @param input.options.meta - include the metadata header (default `true`).
 * @param input.options.generatedAt - export timestamp in ms (default `Date.now()`).
 * @returns the Markdown document.
 */
export function renderTranscript(input) {
  const { header, events, title } = input;
  const options = input.options ?? {};
  const includeReasoning = options.reasoning === true;
  const includeTools = options.tools === true;
  const includeMeta = options.meta !== false;
  const generatedAt = typeof options.generatedAt === 'number' ? options.generatedAt : Date.now();
  const list = Array.isArray(events) ? events : [];

  const heading = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Conversation';
  const out = [`# ${heading}`, EMPTY];

  if (includeMeta) {
    const lines = headerLines(header);
    lines.push(`- **Exported**: ${new Date(generatedAt).toISOString()}`);
    out.push(...lines, EMPTY);
  }

  /** Model/provider seen on the most recent assistant step, for a light touch of context. */
  let lastModel = null;

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue;
    const data = event.data ?? {};
    switch (event.type) {
      case 'user/message': {
        const { text } = splitContent(data.content);
        if (text.trim() === '') break;
        out.push('## User', EMPTY, text, EMPTY);
        break;
      }
      case 'assistant/message': {
        const { text, reasoning } = splitContent(data.content);
        const blocks = splitContent(data.blocks);
        const answer = text.trim() !== '' ? text : blocks.text;
        const thoughts = reasoning.trim() !== '' ? reasoning : blocks.reasoning;
        if (typeof data.model === 'string') lastModel = data.model;
        if (answer.trim() === '' && thoughts.trim() === '') break;
        out.push('## Assistant', EMPTY);
        if (includeReasoning && thoughts.trim() !== '') out.push(details('Thinking', thoughts), EMPTY);
        if (answer.trim() !== '') out.push(answer, EMPTY);
        break;
      }
      case 'tool/call': {
        if (!includeTools) break;
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}, null, 2);
        out.push(details(`Tool call · \`${name}\``, indent(args)), EMPTY);
        break;
      }
      case 'tool/result': {
        if (!includeTools) break;
        const body = toolResultText(data);
        if (body.trim() === '') break;
        out.push(details('Tool result', indent(body)), EMPTY);
        break;
      }
      case 'system/message': {
        if (!includeTools) break;
        const { text } = splitContent(data.content);
        if (text.trim() === '') break;
        out.push(details('System message', indent(text)), EMPTY);
        break;
      }
      case 'compaction/summary': {
        const { text } = splitContent(data.summary);
        if (text.trim() === '') break;
        out.push('## Compacted history', EMPTY, text, EMPTY);
        break;
      }
      default:
        break;
    }
  }

  if (includeMeta && lastModel !== null) out.push('---', EMPTY, `_Last step ran on \`${lastModel}\`._`, EMPTY);

  // Collapse the trailing blank line so the document ends with exactly one \n.
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
