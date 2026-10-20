const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseClaude } = require('../lib/parse-claude');
const { parseCodex } = require('../lib/parse-codex');
const { compute, isCheck } = require('../lib/stats');

const fx = (f) => path.join(__dirname, 'fixtures', f);

test('claude pass: planned, tested every burst', () => {
  const r = compute(parseClaude(fx('claude-pass.jsonl')).events);
  assert.deepEqual(r.stats, { planning_used: true, edits: 3, tests_after_edits_ratio: 1, interrupts: 0, rejections: 0, error_loops: 0, tools_used: ['git', 'npm', 'plan', 'pytest', 'subagent'], languages: ['python', 'typescript'] });
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
