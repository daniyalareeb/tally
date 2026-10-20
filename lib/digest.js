const fs = require('fs');
const path = require('path');
const { compute } = require('./stats');
const { scrubPrompt, secretHits } = require('./redact');
const { parseClaude } = require('./parse-claude');
const { parseCodex } = require('./parse-codex');
const store = require('./store');

const MAX_PROMPT = 400;
const FIRST_PROMPTS = 12;
// shortcut: cap on post-failure prompts keeps the upload small, raise if scoring needs more debugging evidence
const MAX_PROMPTS = 40;

const TOP_FIELDS = ['session_id', 'tool', 'started_at', 'duration_min', 'turns', 'repo_hash', 'commits', 'stats', 'prompts'];
const STAT_FIELDS = ['planning_used', 'edits', 'tests_after_edits_ratio', 'interrupts', 'rejections', 'error_loops', 'tools_used', 'languages', 'prod_commands', 'files_touched', 'lines_changed', 'test_edits', 'typecheck_runs', 'lint_runs', 'hours_utc', 'tokens', 'min_to_first_commit', 'redaction_hits'];

function buildDigest(parsed, extra) {
  const { turns, duration_min, stats, prompts } = compute(parsed.events);
  const first = parsed.events.find((e) => e.t != null);
  const repo = parsed.meta.cwd ? path.basename(parsed.meta.cwd) : '';
  const noRepo = (t) => (repo.length >= 4 ? t.split(new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('[repo]') : t);
  const kept = prompts
    .filter((p) => p.i < FIRST_PROMPTS || p.after_failure)
    .slice(0, MAX_PROMPTS)
    .map((p) => ({ i: p.i, text: noRepo(scrubPrompt(p.text)).slice(0, MAX_PROMPT), after_failure: p.after_failure }))
    .filter((p) => p.text.trim());
  const firstCommit = extra && extra.first_commit_ms;
  stats.min_to_first_commit = first && firstCommit ? Math.max(0, Math.round((firstCommit - first.t) / 60000)) : null;
  stats.redaction_hits = prompts.reduce((n, p) => n + secretHits(p.text), 0);
  return {
    session_id: parsed.meta.sessionId,
    tool: parsed.meta.tool,
    started_at: first ? new Date(first.t).toISOString() : null,
    duration_min,
    turns,
    repo_hash: (extra && extra.repo_hash) || null,
    commits: (extra && extra.commits) || [],
    stats,
    prompts: kept,
  };
}

function parseFile(file) {
  let head = '';
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(20000); head = b.toString('utf8', 0, fs.readSync(fd, b, 0, b.length, 0)); fs.closeSync(fd); } catch {}
  return /"type":\s*"(?:session_meta|response_item|event_msg)"/.test(head) ? parseCodex(file) : parseClaude(file);
}

function fromFile(file) {
  const parsed = parseFile(file);
  const times = parsed.events.map((e) => e.t).filter((t) => t != null);
  const cwd = parsed.meta.cwd;
  const log = times.length ? store.commitLog(cwd, Math.min(...times), Math.max(...times)) : [];
  const digest = buildDigest(parsed, {
    repo_hash: store.repoHash(cwd),
    commits: log.map((c) => c.sha),
    first_commit_ms: log.length ? Math.min(...log.map((c) => c.t)) : null,
  });
  return { digest, cwd, repoName: cwd ? path.basename(cwd) : 'unknown repo' };
}

module.exports = { buildDigest, fromFile, TOP_FIELDS, STAT_FIELDS };
