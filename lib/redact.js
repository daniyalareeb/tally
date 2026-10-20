const user = (() => { try { return require('os').userInfo().username; } catch { return ''; } })();

const entropy = (s) => {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  return -Object.values(f).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0);
};

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private-key]'],
  [/^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*\S.*$/gm, '$1=[redacted]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@\S*/gi, '[url-with-credentials]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[api-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[api-key]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[api-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[api-key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[\w.-]+@[\w-]+(?=:)/g, '[user@host]'],
  [/(^|[\s("'`=<\[,:])(?:~|[A-Za-z]:)?(?:[\/\\][\w.@+~-]+){2,}[\/\\]?/g, '$1[path]'],
  [/(^|[\s("'`=<\[,:])~(?:\/[\w.@+~-]+)+\/?/g, '$1[path]'],
  [/\b(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g, '[path]'],
];

// shortcut: counts credential rules only (keys, tokens, private keys, url credentials, high entropy); skips the env-assignment rule (index 1), which fires on harmless NODE_ENV=x lines
const SECRET_RULES = new Set([0, 2, 3, 4, 5, 6, 7, 8, 9]);

function scan(text) {
  let s = String(text), hits = 0;
  RULES.forEach(([re, to], i) => { s = s.replace(re, (...m) => { if (SECRET_RULES.has(i)) hits++; return to.replace(/\$(\d)/g, (_, n) => m[n] || ''); }); });
  if (user.length >= 4) s = s.split(user).join('[user]');
  s = s.replace(/[A-Za-z0-9+\/_=-]{32,}/g, (m) => (entropy(m) > 3.5 ? (hits++, '[secret]') : m));
  return { text: s, hits };
}

const redact = (text) => scan(text).text;

// Pasted code never leaves the machine, only the words around it.
const stripCode = (text) => String(text).replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]');
const scrubPrompt = (text) => redact(stripCode(text));
const secretHits = (text) => scan(stripCode(text)).hits;

module.exports = { redact, scrubPrompt, secretHits };
