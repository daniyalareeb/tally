const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const home = () => process.env.TALLY_HOME || path.join(os.homedir(), '.tally');
const p = (...a) => path.join(home(), ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function git(cwd, args) {
  try {
    return cp.execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// Identity is a hash of the normalized remote URL. No remote: hash of the local path, never sent as text.
function repoHash(cwd) {
  const remote = cwd ? git(cwd, ['remote', 'get-url', 'origin']) : '';
  const norm = (remote || 'local:' + (cwd || '')).toLowerCase()
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/^git@/, '')
    .replace(/:(?!\d)/, '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  return sha(norm).slice(0, 16);
}

function commitsBetween(cwd, startMs, endMs) {
  if (!cwd || !startMs || !endMs) return [];
  const email = git(cwd, ['config', 'user.email']);
  const args = ['log', '--all', '--format=%H', '--since=' + new Date(startMs).toISOString(), '--until=' + new Date(endMs + 60000).toISOString()];
  if (email) args.push('--author=' + email);
  return git(cwd, args).split('\n').filter((s) => /^[0-9a-f]{40}$/.test(s));
}

const isPaused = () => fs.existsSync(p('paused'));
// shortcut: only checks the session cwd, not the git root, upgrade if people keep .tallyignore at repo root and work in subdirs
const isIgnored = (cwd) => !!cwd && fs.existsSync(path.join(cwd, '.tallyignore'));
const isTracked = (hash) => !!readJson(p('projects.json'), {})[hash];

function queueAdd(entry) {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(p('queue'), JSON.stringify(entry) + '\n');
}
function queueTake() {
  const q = p('queue'), work = p('queue.' + process.pid);
  try { fs.renameSync(q, work); } catch { return []; }
  const lines = fs.readFileSync(work, 'utf8').split('\n');
  fs.unlinkSync(work);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    try { const e = JSON.parse(l); if (e && e.path && !seen.has(e.path)) { seen.add(e.path); out.push(e); } } catch {}
  }
  return out;
}

const outboxFile = (id) => p('outbox', id.replace(/[^\w.-]/g, '_') + '.json');
const readOutbox = () => {
  try { return fs.readdirSync(p('outbox')).filter((f) => f.endsWith('.json')).map((f) => readJson(p('outbox', f), null)).filter(Boolean); } catch { return []; }
};

module.exports = { home, p, sha, readJson, writeJson, repoHash, commitsBetween, isPaused, isIgnored, isTracked, queueAdd, queueTake, outboxFile, readOutbox };
