const fmt = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${Math.max(min, 1)}m`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function card(d, repoName) {
  const s = d.stats;
  const lines = [];
  if (s.tests_after_edits_ratio !== null) {
    lines.push(s.tests_after_edits_ratio === 0
      ? 'No tests or build ran after your edits. That is the easiest win.'
      : `Tests or a build ran after ${Math.round(s.tests_after_edits_ratio * 100)}% of your edit bursts.`);
  }
  const stopped = s.interrupts + s.rejections;
  if (stopped) lines.push(`You stopped ${plural(stopped, 'bad change')} instead of accepting them.`);
  if (s.error_loops) lines.push(`${plural(s.error_loops, 'failing test or build run')} got retried.`);
  const lens = d.prompts.map((p) => p.text.length).sort((a, b) => a - b);
  if (lens.length) {
    // shortcut: prompt length stands in for framing quality, the nightly scorer judges the real thing
    const m = lens[Math.floor(lens.length / 2)];
    lines.push(m >= 150 ? `Your prompts carried context (median ${m} characters).` : `Your prompts were short (median ${m} characters). Add the goal and what done looks like.`);
  }
  if (d.commits.length) lines.push(`${plural(d.commits.length, 'commit')} will be checked against GitHub.`);
  if (lines.length < 3) lines.push(`${plural(d.turns, 'turn')}, ${plural(s.edits, 'edit')}.`);
  if (lines.length < 3 && s.planning_used) lines.push('You planned before editing.');
  const pad = '       ';
  return [' ╻╻╻', `(•ᴗ•)  Tally counted this session (${repoName}, ${fmt(d.duration_min)})`, ...lines.slice(0, 5).map((l) => `${pad}- ${l}`)].join('\n');
}

const skippedCard = (why) => ` ╻╻╻\n(•ᴗ•)  Tally skipped this session: ${why}`;

module.exports = { card, skippedCard };
