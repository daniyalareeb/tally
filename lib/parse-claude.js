const fs = require('fs');
const path = require('path');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const lines = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0);
function editLines(name, i) {
  if (name === 'Write') return lines(i.content);
  if (name === 'MultiEdit') return (Array.isArray(i.edits) ? i.edits : []).reduce((n, e) => n + lines(e && e.old_string) + lines(e && e.new_string), 0);
  if (name === 'NotebookEdit') return lines(i.new_source);
  return lines(i.old_string) + lines(i.new_string);
}
const NOISE = /^<(?:command-|local-command|system-reminder|task-notification)/;

function parseClaude(file) {
  const meta = { tool: 'claude-code', sessionId: path.basename(file, '.jsonl'), cwd: null };
  const events = [];
  const calls = new Map();
  const usage = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { meta, events }; }

  for (const line of raw.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const t = Date.parse(o.timestamp);
    const at = Number.isNaN(t) ? null : t;
    if (!meta.cwd && typeof o.cwd === 'string') meta.cwd = o.cwd;
    const c = o.message && o.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const texts = [];
    const u = o.type === 'assistant' && o.message && o.message.usage;
    // streamed lines repeat one message id with growing output_tokens, so the last one wins; cache reads are excluded, they re-count the whole context every turn
    if (u && o.message.id) usage.set(o.message.id, (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0));

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (o.type === 'assistant') {
        if (b.type === 'text') events.push({ t: at, kind: 'assistant' });
        else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input || {};
          const ev = { t: at, kind: 'tool_call', name: b.name };
          if (b.name === 'Bash' && typeof input.command === 'string') ev.text = input.command;
          if (EDIT_TOOLS.has(b.name)) {
            ev.file = String(input.file_path || input.notebook_path || '');
            ev.ext = path.extname(ev.file).slice(1).toLowerCase();
            ev.lines = editLines(b.name, input);
          }
          events.push(ev);
          if (b.id) calls.set(b.id, ev);
        }
      } else if (b.type === 'tool_result') {
        const body = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('') : '';
        if (/^The user doesn't want to proceed/.test(body)) events.push({ t: at, kind: 'rejection' });
        else {
          const call = calls.get(b.tool_use_id) || {};
          events.push({ t: at, kind: 'tool_result', name: call.name, ok: !b.is_error, text: call.text });
        }
      } else if (b.type === 'text' && typeof b.text === 'string' && !o.isMeta) {
        texts.push(b.text);
      }
    }

    if (o.type === 'user' && texts.length) {
      const x = texts.join('\n').trim();
      const last = events[events.length - 1];
      if (x.startsWith('[Request interrupted')) {
        if (!(x.includes('for tool use') && last && last.kind === 'rejection')) events.push({ t: at, kind: 'interrupt' });
      } else if (x && !NOISE.test(x) && !(o.origin && o.origin.kind && o.origin.kind !== 'human')) {
        events.push({ t: at, kind: 'user_prompt', text: x });
      }
    }
  }
  if (usage.size) events.push({ t: null, kind: 'usage', tokens: [...usage.values()].reduce((a, n) => a + n, 0) });
  return { meta, events };
}

module.exports = { parseClaude };
