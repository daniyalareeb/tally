const IDLE_MS = 30 * 60 * 1000;

// shortcut: regex lists, not a shell parser; misses wrapped runners (make test, tox), upgrade when fixtures show misses
const TEST_RE = /\b(?:pytest|py\.test|jest|vitest|mocha|phpunit|rspec|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+(?:test|nextest)|mvn\s+(?:[\w:.-]+\s+)*test|gradlew?\s+(?:[\w:.-]+\s+)*test|dotnet\s+test|node\s+--test|deno\s+test|playwright\s+test)\b/;
const BUILD_RE = /\b(?:tsc|(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|lint|typecheck|check)|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|mvn\s+(?:[\w:.-]+\s+)*(?:compile|package)|gradlew?\s+build|eslint|ruff|mypy|make)\b/;
const isCheck = (cmd) => !!cmd && (TEST_RE.test(cmd) || BUILD_RE.test(cmd));

const KNOWN_CLI = new Set(['git', 'gh', 'docker', 'kubectl', 'terraform', 'make', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'python', 'pip', 'uv', 'pytest', 'jest', 'vitest', 'cargo', 'go', 'mvn', 'gradle', 'dotnet', 'psql', 'supabase', 'vercel', 'curl', 'jq', 'sqlite3', 'tsc', 'eslint', 'prettier', 'ruff']);
const PLAN_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode', 'update_plan']);
const LANG = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', swift: 'swift', sql: 'sql', sh: 'shell', css: 'css', html: 'html', vue: 'vue', svelte: 'svelte' };
// shortcut: planning by keyword in a pre-edit prompt is crude, upgrade once scored sessions show it misfires
const PLAN_WORDS = /\b(?:plan|step by step|outline|approach|before (?:you )?(?:code|edit|write|change))\b/i;

function cliTools(cmd) {
  const out = [];
  for (const seg of String(cmd).split(/&&|\|\||;|\|/)) {
    const tok = seg.trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)[0];
    const name = (tok || '').replace(/^.*\//, '').replace(/^python3$/, 'python');
    if (KNOWN_CLI.has(name)) out.push(name);
  }
  return out;
}

function toolLabel(name) {
  if (name === 'Agent' || name === 'Task') return 'subagent';
  if (name === 'Skill') return 'skill';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web';
  if (/^mcp__/.test(name)) return 'mcp';
  if (PLAN_TOOLS.has(name)) return 'plan';
  return null;
}

function compute(events) {
  const stats = { planning_used: false, edits: 0, tests_after_edits_ratio: null, interrupts: 0, rejections: 0, error_loops: 0, tools_used: [], languages: [] };
  const tools = new Set(), langs = new Set();
  const prompts = [];
  let bursts = 0, verified = 0, inBurst = false, failedSinceLast = false, pendingRetry = null, lastEdit = null;
  let active = 0, prev = null;

  for (const e of events) {
    if (e.t != null) {
      if (prev != null && e.t - prev <= IDLE_MS) active += e.t - prev;
      prev = e.t;
    }
    if (e.kind !== 'rejection' && e.kind !== 'tool_result') lastEdit = e.ext !== undefined ? lastEdit : null;
    if (e.kind === 'user_prompt') {
      if (!stats.planning_used && stats.edits === 0 && PLAN_WORDS.test(e.text)) stats.planning_used = true;
      prompts.push({ i: prompts.length, text: e.text, after_failure: failedSinceLast });
      failedSinceLast = false;
    } else if (e.kind === 'interrupt') stats.interrupts++;
    else if (e.kind === 'rejection') {
      stats.rejections++;
      if (lastEdit) { stats.edits--; if (lastEdit.opened) { bursts--; inBurst = false; } lastEdit = null; }
    }
    else if (e.kind === 'tool_call') {
      const label = toolLabel(e.name);
      if (label) tools.add(label);
      if (label === 'plan') stats.planning_used = true;
      if (e.name === 'Bash' && e.text) {
        cliTools(e.text).forEach((n) => tools.add(n));
        if (pendingRetry === e.name) { stats.error_loops++; pendingRetry = null; }
        if (isCheck(e.text) && inBurst) { verified++; inBurst = false; }
      } else if (e.ext !== undefined) {
        stats.edits++;
        lastEdit = { opened: !inBurst };
        if (!inBurst) { bursts++; inBurst = true; }
        if (LANG[e.ext]) langs.add(LANG[e.ext]);
      }
    } else if (e.kind === 'tool_result' && e.ok === false && isCheck(e.text)) {
      failedSinceLast = true;
      pendingRetry = e.name;
    }
  }

  if (bursts) stats.tests_after_edits_ratio = Math.round((verified / bursts) * 100) / 100;
  stats.tools_used = [...tools].sort();
  stats.languages = [...langs].sort();
  return { turns: prompts.length, duration_min: Math.round(active / 60000), stats, prompts };
}

module.exports = { compute, isCheck };
