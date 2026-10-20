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

function flush() {
  for (const e of store.queueTake()) { try { processFile(e.path); } catch {} }
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

function sync() {
  const now = Date.now();
  for (const f of transcripts()) {
    let m;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (now - m > SYNC_DAYS * 864e5 || now - m < 120000 || isDone(f)) continue;
    try { processFile(f); } catch {}
  }
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
  const pending = store.readOutbox();
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
  login: () => out('Login is coming in Phase 2.'),
};

if (!table[cmd]) fail('usage: tally hook | flush | sync | card | preview | pause | track | profile | project | install codex | login');
table[cmd]();
