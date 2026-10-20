const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaude } = require('../lib/parse-claude');
const { parseCodex } = require('../lib/parse-codex');
const { buildDigest } = require('../lib/digest');

const dir = path.join(__dirname, 'fixtures');
const built = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
  const parse = f.startsWith('codex') ? parseCodex : parseClaude;
  const parsed = parse(path.join(dir, f));
  return { f, repo: parsed.meta.cwd && path.basename(parsed.meta.cwd), json: JSON.stringify(buildDigest(parsed, { repo_hash: 'abc', commits: ['a'.repeat(40)] })) };
});

const secretLines = fs.readFileSync(path.join(dir, 'secrets.txt'), 'utf8');
built.push({ f: 'secrets.txt', json: JSON.stringify(buildDigest({ meta: { tool: 'claude-code', sessionId: 's' }, events: [{ t: 0, kind: 'user_prompt', text: secretLines }] }, {})) });

const user = os.userInfo().username;

test('every fixture has digests', () => assert.ok(built.length >= 6));

for (const { f, repo, json } of built) {
  test(`no leaks in digest of ${f}`, () => {
    const body = json.replace(/"started_at":"[^"]*"/g, '').replace(/"(?:repo_hash|session_id)":"[^"]*"/g, '');
    assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\|~\//.test(body), 'home path');
    assert.ok(!body.includes(user), 'os username');
    assert.ok(!/[\w.@-]*\/[\w.-]+\.[A-Za-z0-9]{1,8}\b/.test(body), 'path with extension');
    assert.ok(!/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.test(body), 'email');
    assert.ok(!/sk-[\w-]{16,}|gh[pousr]_\w{20,}|xox[abprs]-|AKIA[A-Z0-9]{16}|AIza\w{20,}|eyJ[\w-]{8,}\.|Bearer\s+\w{8,}|PRIVATE KEY|:\/\/[^\s/@]+:[^\s/@]+@/.test(body), 'key pattern');
    if (repo) assert.ok(!new RegExp(`\\b${repo}\\b`, 'i').test(body), 'repo name');
  });
}
