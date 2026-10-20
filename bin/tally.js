#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const store = require('../lib/store');

const [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\n');
const fail = (s) => { process.stderr.write(s + '\n'); process.exit(1); };

const PROFILE_KEYS = ['open_to_work', 'location', 'timezone', 'work_mode', 'relocate', 'overlap_hours', 'overlap_zones', 'salary_min', 'currency', 'work_auth', 'needs_sponsorship', 'available_from', 'role_types', 'stage', 'want_stack', 'avoid_stack', 'domains', 'dealbreakers'];
const PROJECT_KEYS = ['kind', 'my_role', 'status', 'outcome', 'team_size', 'share_as'];
const LIST_KEYS = new Set(['overlap_zones', 'work_auth', 'role_types', 'stage', 'want_stack', 'avoid_stack', 'domains']);
const NUM_KEYS = new Set(['salary_min', 'overlap_hours']);
const SYNC_DAYS = 7;
const BACKFILL_DAYS = 30;

function hook() {
  if (store.isPaused()) return;
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
  if (input.transcript_path) store.queueAdd({ path: input.transcript_path, at: Date.now() });
  if (process.env.TALLY_NO_SPAWN) return;
  cp.spawn(process.execPath, [__filename, input.transcript_path ? 'flush' : 'sync'], { detached: true, stdio: 'ignore' }).unref();
}

function processFile(file) {
  const { fromFile } = require('../lib/digest');
  const { card, skippedCard } = require('../lib/card');
  const { digest, cwd, repoName } = fromFile(file);
  const note = (status, why) => store.writeJson(store.p('last.json'), { status, why, at: Date.now() });
  if (!digest.turns) return;
  if (store.isPaused()) return note('skipped', 'Tally is paused.');
  if (store.isIgnored(cwd)) { markDone(file); return note('skipped', 'this repo has a .tallyignore.'); }
  if (!store.isTracked(digest.repo_hash)) return note('skipped', 'this repo is not tracked yet. Run /tally track here.');
  store.writeJson(store.outboxFile(digest.session_id), digest);
  markDone(file);
  store.writeJson(store.p('last.json'), { status: 'counted', session_id: digest.session_id, card: card(digest, repoName), at: Date.now() });
}

const doneFile = () => store.p('done.json');
const isDone = (file) => !!store.readJson(doneFile(), {})[store.sha(file)];
function markDone(file) {
  const d = store.readJson(doneFile(), {});
  d[store.sha(file)] = Date.now();
  store.writeJson(doneFile(), d);
}

async function flush() {
  for (const e of store.queueTake()) { try { processFile(e.path); } catch {} }
  await upload();
}

const config = () => store.readJson(store.p('config.json'), null);
const baseUrl = () => process.env.TALLY_URL || (config() && config().url) || 'https://berelentless.dev';

// Delete an outbox file only once the server has it (201, repeat) or will never take it (400, 413).
async function upload() {
  const cfg = config();
  if (!cfg || !cfg.token) return;
  for (const f of fs.existsSync(store.p('outbox')) ? fs.readdirSync(store.p('outbox')).filter((n) => n.endsWith('.json')) : []) {
    const file = store.p('outbox', f);
    let res;
    try {
      res = await fetch(baseUrl() + '/api/ingest', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' }, body: fs.readFileSync(file) });
    } catch { return; }
    if (res.ok || res.status === 400 || res.status === 413) fs.unlinkSync(file);
    else if (res.status === 401 || res.status === 429) return;
  }
}

async function login() {
  const crypto = require('crypto');
  const token = 'tly_' + crypto.randomBytes(24).toString('hex');
  const hash = store.sha(token);
  const code = Array.from(crypto.randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
  const base = baseUrl();
  const res = await fetch(base + '/api/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, token_hash: hash }) }).catch(() => null);
  if (!res || !res.ok) fail('Could not reach ' + base + '. Check TALLY_URL and try again.');
  const url = `${base}/connect?code=${code}`;
  out(`Your code is ${code}\nOpen ${url} to sign in with GitHub and confirm.`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try { cp.spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
  const wait = Number(process.env.TALLY_POLL_MS) || 2000;
  for (let i = 0; i < 600000 / wait; i++) {
    await new Promise((r) => setTimeout(r, wait));
    const s = await fetch(`${base}/api/device/status?h=${hash}`).then((r) => r.json()).catch(() => ({}));
    if (s.confirmed) {
      store.writeJson(store.p('config.json'), { token, url: base });
      fs.chmodSync(store.p('config.json'), 0o600);
      return out('Connected. Run "tally preview" to see what the next upload contains.');
    }
  }
  fail('Timed out waiting for confirmation. Run tally login again.');
}

function transcripts() {
  const found = [];
  const walk = (dir, re, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const f = path.join(dir, it.name);
      if (it.isDirectory() && depth > 0) walk(f, re, depth - 1);
      else if (it.isFile() && re.test(it.name)) found.push(f);
    }
  };
  walk(path.join(os.homedir(), '.claude', 'projects'), /\.jsonl$/, 1);
  walk(path.join(os.homedir(), '.codex', 'sessions'), /^rollout-.*\.jsonl$/, 3);
  return found;
}

const backfillMarker = () => store.p('backfilled');
const backfillPending = () => !!(config() && config().token) && !fs.existsSync(backfillMarker());

function recentFiles(days) {
  const now = Date.now();
  return transcripts().filter((f) => {
    let m;
    try { m = fs.statSync(f).mtimeMs; } catch { return false; }
    return now - m <= days * 864e5 && now - m >= 120000 && !isDone(f);
  });
}

// Past sessions a first upload would send: tracked, not ignored, not yet counted.
function backfillPlan() {
  if (store.isPaused()) return [];
  const { fromFile } = require('../lib/digest');
  const items = [];
  for (const f of recentFiles(BACKFILL_DAYS)) {
    try {
      const { digest, cwd, repoName } = fromFile(f);
      if (digest.turns && !store.isIgnored(cwd) && store.isTracked(digest.repo_hash)) items.push({ digest, repoName });
    } catch {}
  }
  return items;
}

async function sync() {
  if (!config()) out('Not connected yet, so nothing uploads. Run "tally login" to connect.');
  const first = backfillPending();
  if (first && !args.includes('--yes')) {
    const items = backfillPlan();
    if (!items.length) return out('No past sessions in tracked repos yet. Track a repo, then run tally sync again.');
    const perRepo = {};
    for (const i of items) perRepo[i.repoName] = (perRepo[i.repoName] || 0) + 1;
    out(`Tally can count ${items.length} past session${items.length === 1 ? '' : 's'} from the last ${BACKFILL_DAYS} days:\n` +
      Object.entries(perRepo).map(([r, n]) => `  ${r}: ${n}`).join('\n') +
      '\nRun "tally preview" to see exactly what would be sent, then "tally sync --yes" to upload it.');
    return;
  }
  for (const f of recentFiles(first ? BACKFILL_DAYS : SYNC_DAYS)) {
    try { processFile(f); } catch {}
  }
  if (first) { store.writeJson(backfillMarker(), { at: Date.now() }); await upload(); }
}

function showCard(file) {
  const { fromFile } = require('../lib/digest');
  const { card } = require('../lib/card');
  if (file) { const r = fromFile(file); return out(card(r.digest, r.repoName)); }
  const last = store.readJson(store.p('last.json'), null);
  if (!last) return out(' ╻╻╻\n(•ᴗ•)  No sessions yet. Finish a session in a tracked repo and I will count it.');
  const { skippedCard } = require('../lib/card');
  out(last.status === 'counted' ? last.card : skippedCard(last.why));
}

function preview(file) {
  if (file) return out(JSON.stringify(require('../lib/digest').fromFile(file).digest, null, 2));
  const pending = [...store.readOutbox(), ...(backfillPending() ? backfillPlan().map((i) => i.digest) : [])];
  out(pending.length ? JSON.stringify(pending, null, 2) : 'Nothing waiting to upload.');
}


function parseValue(key, words) {
  const v = words.join(' ').trim();
  if (LIST_KEYS.has(key)) return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (NUM_KEYS.has(key) && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function show(obj) {
  const keys = Object.keys(obj);
  out(keys.length ? keys.map((k) => `${k}: ${Array.isArray(obj[k]) ? obj[k].join(', ') : obj[k]}`).join('\n') : '(empty)');
}

function profile([sub, key, ...rest]) {
  const f = store.p('profile.json');
  const data = store.readJson(f, {});
  if (sub === 'get') return key ? out(String(data[key] ?? '')) : show(data);
  if (sub !== 'set' || !PROFILE_KEYS.includes(key) || !rest.length) fail('usage: tally profile get [key] | set <key> <value>\nkeys: ' + PROFILE_KEYS.join(', '));
  data[key] = parseValue(key, rest);
  store.writeJson(f, data);
  out(`saved ${key}`);
}

function project([sub, key, ...rest]) {
  const { redact } = require('../lib/redact');
  const hash = store.repoHash(process.cwd());
  const f = store.p('projects.json');
  const all = store.readJson(f, {});
  if (sub === 'get') return all[hash] ? show(all[hash]) : out('not tracked');
  if (sub !== 'set' || !PROJECT_KEYS.includes(key) || !rest.length) fail('usage: tally project get | set <key> <value>\nkeys: ' + PROJECT_KEYS.join(', '));
  all[hash] = { ...all[hash], [key]: redact(rest.join(' ').trim()) };
  store.writeJson(f, all);
  out(`saved ${key}`);
}

function track() {
  const f = store.p('projects.json');
  const all = store.readJson(f, {});
  const hash = store.repoHash(process.cwd());
  all[hash] = all[hash] || { tracked_at: new Date().toISOString().slice(0, 10) };
  store.writeJson(f, all);
  out('Tracking this repo. Run /tally track to fill in the project card.');
}

function pause([flag]) {
  const f = store.p('paused');
  if (flag === 'off') { try { fs.unlinkSync(f); } catch {} return out('Tally resumed.'); }
  fs.mkdirSync(store.home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, '');
  out('Tally is paused. Nothing is captured. Run "tally pause off" to resume.');
}

function installCodex() {
  const f = path.join(os.homedir(), '.codex', 'hooks.json');
  const data = store.readJson(f, {});
  const command = `node ${path.resolve(__dirname, 'tally.js')} hook`;
  data.hooks = data.hooks || {};
  const list = (data.hooks.SessionEnd = data.hooks.SessionEnd || []);
  if (!JSON.stringify(list).includes('tally.js')) list.push({ hooks: [{ type: 'command', command, timeout: 3 }] });
  store.writeJson(f, data);
  out('Wrote the SessionEnd hook to ' + f);
}

const table = {
  hook, flush, sync,
  card: () => showCard(args[0]),
  preview: () => preview(args[0]),
  pause: () => pause(args),
  track,
  profile: () => profile(args),
  project: () => project(args),
  install: () => (args[0] === 'codex' ? installCodex() : fail('usage: tally install codex')),
  login,
};

if (!cmd) {
  out(' ╻╻╻\n(•ᴗ•)  Hi, I am Tally.\n\n  tally login     connect this machine\n  tally track     count sessions in this repo\n  tally card      what I counted last\n  tally preview   exactly what would be uploaded\n  tally pause     stop counting (tally pause off to resume)\n\nIn Claude Code, /tally does all of this for you.');
  process.exit(0);
}
if (!table[cmd]) fail('usage: tally hook | flush | sync | card | preview | pause | track | profile | project | install codex | login');
table[cmd]();
