const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { redact, scrubPrompt } = require('../lib/redact');

const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'secrets.txt'), 'utf8');
const out = redact(raw);

test('no secret survives', () => {
  for (const s of ['sk-proj-', 'ghp_', 'gho_', 'xoxb-', 'AKIAIOSFODNN7', 'AIzaSy', 'eyJhbGci', 'abcDEF1234567890xyz', 'MIIEow', 'jane.doe', 'hunter2', 'postgres://x', 'whsec_', 'Zx9Qm4Tt7Lp2', '/home/dev', '~/projects', 'C:\\Users', 'src/lib/checkout.ts', 'dev@laptop', '~/work', '/srv/app']) {
    assert.ok(!out.includes(s), `leaked ${s}`);
  }
});

test('ordinary words and commands survive', () => {
  const s = redact('run /tally preview then fix the 401 in refresh() and keep and/or semantics');
  assert.equal(s, 'run /tally preview then fix the 401 in refresh() and keep and/or semantics');
});

test('redaction happens before truncation', () => {
  const text = 'x'.repeat(380) + ' sk-proj-abcdefghijklmnopqrstuvwx1234';
  assert.ok(!scrubPrompt(text).slice(0, 400).includes('sk-proj-abcdefghij'));
});

test('pasted code is dropped', () => {
  assert.equal(scrubPrompt('fix this\n```js\nconst a = 1;\n```\nthanks'), 'fix this\n[code omitted]\nthanks');
});

test('urls keep their host and are not mistaken for paths', () => {
  assert.equal(redact('see https://react.dev/link/react-devtools now'), 'see https://react.dev/link/react-devtools now');
});

test('the local username is removed', () => {
  const u = require('os').userInfo().username;
  if (u.length >= 4) assert.ok(!redact(`signed in as ${u} today`).includes(u));
});
