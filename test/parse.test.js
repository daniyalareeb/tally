const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseClaude } = require('../lib/parse-claude');
const { parseCodex } = require('../lib/parse-codex');

const fx = (f) => path.join(__dirname, 'fixtures', f);
const kinds = (r) => r.events.map((e) => e.kind);

test('claude: prompts, tool calls and results are normalized', () => {
  const r = parseClaude(fx('claude-pass.jsonl'));
  assert.equal(r.meta.cwd, '/home/dev/shop');
  assert.equal(r.events.filter((e) => e.kind === 'user_prompt').length, 2);
  const res = r.events.find((e) => e.kind === 'tool_result' && e.text === 'npm test');
  assert.deepEqual([res.name, res.ok], ['Bash', true]);
});

test('claude: rejection and interrupt are separate, meta lines are not prompts', () => {
  const r = parseClaude(fx('claude-errloop.jsonl'));
  assert.equal(kinds(r).filter((k) => k === 'rejection').length, 1);
  assert.equal(kinds(r).filter((k) => k === 'interrupt').length, 1);
  assert.equal(parseClaude(fx('claude-malformed.jsonl')).events.filter((e) => e.kind === 'user_prompt').length, 1);
});

test('claude: malformed input never throws', () => {
  assert.doesNotThrow(() => parseClaude(fx('claude-malformed.jsonl')));
  assert.deepEqual(parseClaude('/nonexistent/file.jsonl').events, []);
});

test('codex: prompts come from user_message, patches become Edit, exit codes set ok', () => {
  const r = parseCodex(fx('codex-pass.jsonl'));
  assert.equal(r.meta.sessionId, 'codex-pass');
  assert.equal(r.events.filter((e) => e.kind === 'user_prompt').length, 1);
  assert.deepEqual(r.events.filter((e) => e.kind === 'tool_call' && e.name === 'Edit').map((e) => e.ext), ['sql', 'go']);
  const bad = parseCodex(fx('codex-errloop.jsonl')).events.filter((e) => e.kind === 'tool_result' && !e.ok);
  assert.equal(bad.length, 2);
  assert.equal(kinds(parseCodex(fx('codex-errloop.jsonl'))).filter((k) => k === 'interrupt').length, 1);
});
