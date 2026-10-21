const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'tally.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tally-'));
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, () => res(s)); });
const run = (args, env) => new Promise((res) => {
  const c = cp.spawn(process.execPath, [bin, ...args], { env: { ...process.env, PATH: '', ...env } });
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => res({ code, out }));
});

test('login sends only the token hash and stores the token after confirmation', async () => {
  const seen = {};
  let polls = 0;
  const srv = await listen((req, res) => {
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/api/device/start') seen.start = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/api/device/status') ? { confirmed: ++polls > 1 } : { ok: true }));
    });
  });
  const home = tmp();
  const r = await run(['login'], { TALLY_HOME: home, TALLY_URL: 'http://127.0.0.1:' + srv.address().port, TALLY_POLL_MS: '20' });
  srv.close();
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.match(cfg.token, /^tly_[0-9a-f]{48}$/);
  assert.equal(seen.start.token_hash, require('crypto').createHash('sha256').update(cfg.token).digest('hex'));
  assert.ok(!JSON.stringify(seen.start).includes(cfg.token));
  assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
});

test('flush posts the outbox, deletes on success, keeps on 401 and 429', async () => {
  let status = 201;
  const got = [];
  const srv = await listen((req, res) => {
    got.push(req.headers.authorization);
    res.statusCode = status; res.end('{}');
  });
  const home = tmp();
  const env = { TALLY_HOME: home, TALLY_URL: 'http://127.0.0.1:' + srv.address().port };
  fs.mkdirSync(path.join(home, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ token: 'tly_x' }));
  const f = path.join(home, 'outbox', 's1.json');
  for (const s of [401, 429]) {
    status = s; fs.writeFileSync(f, '{"session_id":"s1"}');
    await run(['flush'], env);
    assert.ok(fs.existsSync(f), 'kept on ' + s);
  }
  status = 201;
  await run(['flush'], env);
  srv.close();
  assert.ok(!fs.existsSync(f));
  assert.equal(got.at(-1), 'Bearer tly_x');
});

test('flush without login uploads nothing and keeps the outbox', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(home, 'outbox', 's1.json'), '{}');
  await run(['flush'], { TALLY_HOME: home });
  assert.ok(fs.existsSync(path.join(home, 'outbox', 's1.json')));
});

test('card says so when uploads are failing or repos are skipped', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(home, 'outbox', 'a.json'), '{}');
  fs.writeFileSync(path.join(home, 'upload.json'), JSON.stringify({ status: 'network' }));
  fs.writeFileSync(path.join(home, 'untracked.json'), JSON.stringify({ x: 1, y: 2 }));
  const r = await run(['card'], { TALLY_HOME: home });
  assert.match(r.out, /1 waiting to upload/);
  assert.match(r.out, /2 sessions skipped in repos you have not tracked/);
  fs.writeFileSync(path.join(home, 'upload.json'), JSON.stringify({ status: 401 }));
  assert.match((await run(['card'], { TALLY_HOME: home })).out, /Run tally login again/);
});
