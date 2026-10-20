const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseClaude } = require('../lib/parse-claude');
const { parseCodex } = require('../lib/parse-codex');
const { buildDigest, TOP_FIELDS, STAT_FIELDS } = require('../lib/digest');
const { card } = require('../lib/card');

const fx = (f) => path.join(__dirname, 'fixtures', f);
const all = [
  buildDigest(parseClaude(fx('claude-pass.jsonl')), { repo_hash: 'abc', commits: [] }),
  buildDigest(parseClaude(fx('claude-errloop.jsonl')), { repo_hash: 'abc', commits: ['a'.repeat(40)] }),
  buildDigest(parseClaude(fx('claude-malformed.jsonl')), {}),
  buildDigest(parseCodex(fx('codex-pass.jsonl')), {}),
  buildDigest(parseCodex(fx('codex-errloop.jsonl')), {}),
];

test('digest has only allowed fields', () => {
  for (const d of all) {
    assert.deepEqual(Object.keys(d).sort(), [...TOP_FIELDS].sort());
    assert.deepEqual(Object.keys(d.stats).sort(), [...STAT_FIELDS].sort());
    for (const p of d.prompts) assert.deepEqual(Object.keys(p).sort(), ['after_failure', 'i', 'text']);
  }
});

test('digest has no paths, secrets, emails or repo names', () => {
  const json = JSON.stringify(all);
  assert.ok(!/\/home\/|\/Users\/|C:\\|~\//.test(json), 'absolute path');
  assert.ok(!/\b[\w-]+\/[\w.-]+\.\w{1,5}\b/.test(json.replace(/"started_at":"[^"]*"/g, '')), 'relative path');
  assert.ok(!/sk-proj|dev@example|\bshop\b|webhook\.ts|auth\.py/.test(json), 'secret, email or repo name');
});

test('prompts are capped at 400 chars, first 12 plus post-failure, indexed', () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push({ t: i, kind: 'user_prompt', text: 'y'.repeat(900) });
  events.splice(15, 0, { t: 14, kind: 'tool_call', name: 'Bash', text: 'pytest' }, { t: 14, kind: 'tool_result', name: 'Bash', ok: false, text: 'pytest' });
  const d = buildDigest({ meta: { tool: 'claude-code', sessionId: 's' }, events }, {});
  assert.ok(d.prompts.every((p) => p.text.length <= 400));
  assert.deepEqual(d.prompts.map((p) => p.i), [...Array(12).keys(), 15]);
  assert.equal(d.prompts[12].after_failure, true);
});

test('card is 3 to 5 lines under the mascot', () => {
  for (const d of all) {
    const lines = card(d, 'repo').split('\n');
    assert.equal(lines[0], ' ╻╻╻');
    assert.match(lines[1], /^\(•ᴗ•\)  Tally counted this session \(repo, \d+(h \d+)?m\)$/);
    assert.ok(lines.length - 2 >= 3 && lines.length - 2 <= 5, lines.join('\n'));
  }
});
