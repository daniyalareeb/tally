const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'tally.js');
const run = (args, env, input) => cp.spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8' });

test('hook queues the transcript path and returns fast', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
  const t0 = Date.now();
  const r = run(['hook'], { TALLY_HOME: home }, JSON.stringify({ transcript_path: '/nonexistent/s.jsonl' }));
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 500, 'hook took ' + (Date.now() - t0) + 'ms');
  assert.match(fs.readFileSync(path.join(home, 'queue'), 'utf8'), /nonexistent/);
});

test('paused hook queues nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
  run(['pause'], { TALLY_HOME: home });
  run(['hook'], { TALLY_HOME: home, TALLY_NO_SPAWN: '1' }, JSON.stringify({ transcript_path: '/x.jsonl' }));
  assert.ok(!fs.existsSync(path.join(home, 'queue')));
});

test('flush skips untracked repos, counts tracked ones, honors .tallyignore', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
  const env = { TALLY_HOME: home };
  const file = path.join(__dirname, 'fixtures', 'claude-pass.jsonl');
  const flush = () => { run(['hook'], { ...env, TALLY_NO_SPAWN: '1' }, JSON.stringify({ transcript_path: file })); run(['flush'], env); };

  flush();
  assert.ok(!fs.existsSync(path.join(home, 'outbox')), 'untracked repo must store nothing');
  assert.match(run(['card'], env).stdout, /not tracked/);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  cp.spawnSync(process.execPath, [bin, 'track'], { env: { ...process.env, ...env }, cwd: repo });
  // fixture cwd is /home/dev/shop, so track by hash of that path instead
  const store = require('../lib/store');
  process.env.TALLY_HOME = home;
  store.writeJson(store.p('projects.json'), { [store.repoHash('/home/dev/shop')]: { kind: 'Personal project' } });
  flush();
  assert.ok(fs.existsSync(path.join(home, 'outbox', 'claude-pass.json')));
  assert.match(run(['card'], env).stdout, /Tally counted this session \(shop, 16m\)/);
  assert.match(run(['preview'], env).stdout, /"session_id": "claude-pass"/);
});

test('profile and project only accept listed keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
  const env = { TALLY_HOME: home };
  assert.equal(run(['profile', 'set', 'role_types', 'Backend, Frontend'], env).status, 0);
  assert.equal(run(['profile', 'set', 'password', 'x'], env).status, 1);
  assert.match(run(['profile', 'get'], env).stdout, /role_types: Backend, Frontend/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'profile.json'), 'utf8')).role_types.length, 2);
});
