const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'tally.js');
const fixture = path.join(__dirname, 'fixtures', 'claude-pass.jsonl');
const run = (args, env) => new Promise((res) => {
  const c = cp.spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } });
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => res({ code, out }));
});

test('first sync after login lists 30 days and uploads nothing until --yes, then writes the marker', async () => {
  const sent = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { sent.push(JSON.parse(b).session_id); res.statusCode = 201; res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const dir = path.join(userHome, '.claude', 'projects', 'shop');
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, daysOld) => {
    const f = path.join(dir, name + '.jsonl');
    fs.copyFileSync(fixture, f);
    const t = new Date(Date.now() - daysOld * 864e5);
    fs.utimesSync(f, t, t);
  };
  put('old', 20);
  const env = { TALLY_HOME: home, HOME: userHome, USERPROFILE: userHome, TALLY_URL: 'http://127.0.0.1:' + srv.address().port };
  const store = require('../lib/store');
  process.env.TALLY_HOME = home;
  store.writeJson(store.p('projects.json'), { [store.repoHash('/home/dev/shop')]: { kind: 'Personal project' } });
  store.writeJson(store.p('config.json'), { token: 'tly_' + 'a'.repeat(48) });

  const first = await run(['sync'], env);
  assert.match(first.out, /1 past session/);
  assert.match(first.out, /shop: 1/);
  assert.match((await run(['preview'], env)).out, /"session_id": "old"/);
  assert.ok(!fs.existsSync(path.join(home, 'backfilled')));
  assert.ok(!fs.existsSync(path.join(home, 'outbox')));
  assert.deepEqual(sent, []);

  const yes = await run(['sync', '--yes'], env);
  assert.equal(yes.code, 0, yes.out);
  assert.ok(fs.existsSync(path.join(home, 'backfilled')));
  assert.deepEqual(sent, ['old']);

  put('older', 20);
  put('recent', 2);
  await run(['sync'], env);
  srv.closeAllConnections();
  srv.close();
  assert.deepEqual(fs.readdirSync(path.join(home, 'outbox')), ['recent.json'], 'after the marker only the last 7 days are read');
});
