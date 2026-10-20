const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseClaude } = require('../lib/parse-claude');
const { parseCodex } = require('../lib/parse-codex');
const { compute, isCheck } = require('../lib/stats');

const hours = (o) => Array.from({ length: 24 }, (_, h) => o[h] || 0);
const fx = (f) => path.join(__dirname, 'fixtures', f);

test('claude pass: planned, tested every burst', () => {
  const r = compute(parseClaude(fx('claude-pass.jsonl')).events);
  assert.deepEqual(r.stats, { planning_used: true, edits: 3, tests_after_edits_ratio: 1, interrupts: 0, rejections: 0, error_loops: 0, tools_used: ['git', 'npm', 'plan', 'pytest', 'subagent'], languages: ['python', 'typescript'], prod_commands: {}, files_touched: 3, lines_changed: 5, test_edits: 1, typecheck_runs: 0, lint_runs: 0, hours_utc: hours({ 10: 16 }), tokens: null });
  assert.equal(r.turns, 2);
  assert.equal(r.duration_min, 16);
});

test('claude errloop: retries, rejection undoes the edit, idle gap is not counted', () => {
  const r = compute(parseClaude(fx('claude-errloop.jsonl')).events);
  assert.equal(r.stats.error_loops, 2);
  assert.equal(r.stats.rejections, 1);
  assert.equal(r.stats.interrupts, 1);
  assert.equal(r.stats.edits, 2);
  assert.equal(r.duration_min, 10);
  assert.deepEqual(r.prompts.map((p) => p.after_failure), [false, true, true, false]);
});

test('claude malformed: counts what it can', () => {
  const r = compute(parseClaude(fx('claude-malformed.jsonl')).events);
  assert.equal(r.turns, 1);
  assert.equal(r.stats.tests_after_edits_ratio, 0);
});

test('codex: same stats from the other format', () => {
  const pass = compute(parseCodex(fx('codex-pass.jsonl')).events);
  assert.equal(pass.stats.planning_used, true);
  assert.equal(pass.stats.tests_after_edits_ratio, 1);
  assert.deepEqual(pass.stats.languages, ['go', 'sql']);
  const loop = compute(parseCodex(fx('codex-errloop.jsonl')).events);
  assert.equal(loop.stats.error_loops, 2);
  assert.equal(loop.stats.interrupts, 1);
  assert.deepEqual(loop.prompts.map((p) => p.after_failure), [false, true]);
});

test('test and build detection', () => {
  for (const c of ['pytest -q', 'npm test', 'pnpm run test', 'go test ./...', 'cargo test', 'npx vitest run', 'mvn -q test', 'node --test', 'npm run build']) assert.ok(isCheck(c), c);
  for (const c of ['git status', 'ls', 'cat testing.md', 'grep test file']) assert.ok(!isCheck(c), c);
});

test('new signals: prod commands, size, test edits, checks, hours, tokens, rejected edit undone', () => {
  const H = 3600e3, call = (t, name, o) => ({ t, kind: 'tool_call', name, ...o });
  const events = [
    { t: 0, kind: 'user_prompt', text: 'go' },
    call(60e3, 'Bash', { text: 'vercel deploy --prod && prisma migrate deploy' }),
    call(2 * 60e3, 'Bash', { text: 'terraform apply; gh workflow run ci.yml' }),
    call(3 * 60e3, 'Bash', { text: 'npx tsc --noEmit && npm run lint' }),
    call(4 * 60e3, 'Edit', { ext: 'ts', file: 'src/a.ts', lines: 4 }),
    call(5 * 60e3, 'Edit', { ext: 'ts', file: 'src/a.test.ts', lines: 6 }),
    call(6 * 60e3, 'Edit', { ext: 'ts', file: 'src/b.ts', lines: 100 }),
    { t: 6 * 60e3, kind: 'rejection' },
    { t: 7 * 60e3 + H, kind: 'user_prompt', text: 'later' },
    { t: null, kind: 'usage', tokens: 1234 },
  ];
  const s = compute(events).stats;
  assert.deepEqual(s.prod_commands, { deploy: 1, migration: 1, infra: 1, ci: 1 });
  assert.equal(s.typecheck_runs, 1);
  assert.equal(s.lint_runs, 1);
  assert.equal(s.files_touched, 2);
  assert.equal(s.lines_changed, 10);
  assert.equal(s.test_edits, 1);
  assert.equal(s.tokens, 1234);
  assert.equal(s.hours_utc.length, 24);
  assert.equal(s.hours_utc[0], 6);
});

test('claude usage keeps the last line per message id, codex patches count lines per file', () => {
  const line = (id, out) => JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 2, output_tokens: out, cache_creation_input_tokens: 10, cache_read_input_tokens: 99999 } } });
  const f = require('path').join(require('os').tmpdir(), `tally-usage-${process.pid}.jsonl`);
  require('fs').writeFileSync(f, [line('m1', 5), line('m1', 50), line('m2', 7)].join('\n'));
  const usage = parseClaude(f).events.find((e) => e.kind === 'usage');
  require('fs').unlinkSync(f);
  assert.equal(usage.tokens, 2 + 50 + 10 + 2 + 7 + 10);
  const evs = parseCodex(fx('codex-pass.jsonl')).events.filter((e) => e.kind === 'tool_call' && e.name === 'Edit');
  assert.deepEqual(evs.map((e) => [e.file, e.lines]), [['db/migrations/0042.sql', 2], ['internal/orders/repo.go', 2]]);
});
