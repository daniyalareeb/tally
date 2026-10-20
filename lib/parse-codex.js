const fs = require('fs');
const path = require('path');

const SHELL = new Set(['shell', 'exec_command', 'local_shell', 'container.exec']);

function shellText(args) {
  if (typeof args.cmd === 'string') return args.cmd;
  const c = args.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return /^(?:bash|sh|zsh)$/.test(path.basename(String(c[0]))) && c.length >= 3 ? String(c[c.length - 1]) : c.join(' ');
  return '';
}

function patchFiles(patch) {
  const out = [];
  for (const sec of String(patch).split(/^(?=\*\*\* (?:Add|Update|Delete) File: )/m)) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(sec);
    if (!m) continue;
    const file = m[1].trim();
    out.push({ file, ext: path.extname(file).slice(1).toLowerCase(), lines: (sec.match(/^[+-]/gm) || []).length });
  }
  return out.length ? out : [{ file: '', ext: '', lines: 0 }];
}

function exitOk(output) {
  const s = typeof output === 'string' ? output : JSON.stringify(output || '');
  try {
    const j = JSON.parse(s);
    if (j && j.metadata && typeof j.metadata.exit_code === 'number') return j.metadata.exit_code === 0;
  } catch {}
  const m = /exit code:?\s*(-?\d+)/i.exec(s);
  return m ? Number(m[1]) === 0 : true;
}

// Verified against codex-cli 0.154 for session_meta and user prompts (item_completed/UserMessage, no event_msg/user_message). Tool-call shapes are still from the open-source format: that run was unauthenticated.
function parseCodex(file) {
  const meta = { tool: 'codex', sessionId: path.basename(file, '.jsonl'), cwd: null };
  const events = [];
  const calls = new Map();
  let tokens = 0;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { meta, events }; }

  for (const line of raw.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || !o.payload || typeof o.payload !== 'object') continue;
    const p = o.payload;
    const t = Date.parse(o.timestamp);
    const at = Number.isNaN(t) ? null : t;

    if (o.type === 'session_meta') {
      if (typeof p.id === 'string') meta.sessionId = p.id;
      if (typeof p.cwd === 'string') meta.cwd = p.cwd;
    } else if (o.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) events.push({ t: at, kind: 'user_prompt', text: p.message.trim() });
      else if (p.type === 'agent_message') events.push({ t: at, kind: 'assistant' });
      else if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') {
        const text = (Array.isArray(p.item.content) ? p.item.content : []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
        const last = events[events.length - 1];
        if (text && !(last && last.kind === 'user_prompt' && last.text === text)) events.push({ t: at, kind: 'user_prompt', text });
      } else if (p.type === 'item_completed' && p.item && p.item.type === 'AgentMessage') events.push({ t: at, kind: 'assistant' });
      else if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        // shortcut: token_count shape is from the open-source format, unverified on a real session; fresh input + output only, upgrade when a real rollout disagrees
        const u = p.info.total_token_usage;
        tokens = Math.max(tokens, (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0));
      } else if (p.type === 'turn_aborted') events.push({ t: at, kind: 'interrupt' });
    } else if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        let args = {};
        if (typeof p.arguments === 'string') { try { args = JSON.parse(p.arguments); } catch {} }
        else if (p.action && typeof p.action === 'object') args = p.action;
        const name = p.name || 'shell';
        const cmd = SHELL.has(name) || p.type === 'local_shell_call' ? shellText(args) : '';
        const patch = name === 'apply_patch' ? p.input : /^\s*apply_patch\b/.test(cmd) ? cmd : null;
        let first;
        if (patch !== null) {
          for (const f of patchFiles(patch)) { first = { t: at, kind: 'tool_call', name: 'Edit', ...f }; events.push(first); }
        } else {
          first = { t: at, kind: 'tool_call', name: cmd || SHELL.has(name) ? 'Bash' : name };
          if (cmd) first.text = cmd;
          events.push(first);
        }
        if (p.call_id) calls.set(p.call_id, first);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const call = calls.get(p.call_id) || {};
        events.push({ t: at, kind: 'tool_result', name: call.name, ok: exitOk(p.output), text: call.text });
      }
    }
  }
  if (tokens) events.push({ t: null, kind: 'usage', tokens });
  return { meta, events };
}

module.exports = { parseCodex };
