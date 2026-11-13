// Keys and personal data: find them (documents must not contain any) and
// redact them (text taken from code, such as messages and labels, before it
// goes into a fact pack).
//
// WHY both lists: a document is shared with owners, testers and clients, and
// Nadi Tarangini handles health data (India's DPDP Act applies). A key-like
// string or a real phone number in a document is a leak even when the code
// holds it.

export const KEY_PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Stripe key', /\b[sr]k_(live|test)_[0-9A-Za-z]{10,}\b/],
  ['Razorpay key', /\brzp_(live|test)_[0-9A-Za-z]{8,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['JWT', /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Laravel app key', /\bbase64:[A-Za-z0-9+/]{30,}={0,2}/],
  ['password or secret value', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"'`,;]{8,}/i],
];

const EXAMPLE_EMAIL = /@(example\.(com|org|net)|test\.com|domain\.com|email\.com|yourcompany\.com|company\.com)$|^(user|name|someone|test|admin|info|support|no-?reply)@/i;

export const PERSONAL_PATTERNS = [
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, (m) => !EXAMPLE_EMAIL.test(m)],
  // 9000000000-9000000999 is kept for made-up test data (tester-rules.md)
  ['phone number', /(?<![\d.:/-])(?:\+91[\s-]?)?[6-9]\d{9}(?![\d:/-]|\.\d)/, (m) => !/9000000\d{3}$/.test(m.replace(/\D/g, ''))],
  ['Aadhaar-like number', /(?<![\d.:/-])[2-9]\d{3}[\s-]\d{4}[\s-]\d{4}(?![\d.:/-])/],
  ['PAN-like number', /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/],
];

// Every risky value in a text: [{ line, type }]. The value itself is never
// returned, so a report cannot repeat it.
export function scanText(text, { skipLines = new Set() } = {}) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (skipLines.has(i + 1)) return;
    for (const [type, re] of KEY_PATTERNS) if (re.test(l)) out.push({ line: i + 1, type, kind: 'key' });
    for (const [type, re, keep] of PERSONAL_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      for (const m of l.matchAll(g)) if (!keep || keep(m[0])) {
        out.push({ line: i + 1, type, kind: 'personal' });
        break;
      }
    }
  });
  return out;
}

export function redact(s) {
  let t = String(s);
  for (const [type, re] of KEY_PATTERNS) t = t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), `[REDACTED ${type}]`);
  for (const [type, re, keep] of PERSONAL_PATTERNS) t = t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), (m) => (!keep || keep(m) ? `[REDACTED ${type}]` : m));
  return t;
}
