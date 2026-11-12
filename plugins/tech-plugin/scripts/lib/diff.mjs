// Line diff for /tech-plugin:validate: which lines of a document changed since
// its last check, and which parts of an input document (spec, BRD) changed
// since a later document was stamped from it.
//
// WHY: a later checker pass re-checks only what changed, and a BRD or PRD is
// updated only where it depends on a changed part of the spec. Without a diff
// every pass re-reads everything and never settles.

// Hunks between two arrays of lines. Line numbers are 1-based; an empty side
// has start = end + 1 (the place where lines were added or removed).
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  // longest common subsequence, table of suffix lengths
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  }
  const hunks = [];
  let cur = null;
  const open = (i, j) => {
    if (!cur) cur = { aStart: pre + i + 1, bStart: pre + j + 1, a: [], b: [] };
  };
  const close = () => {
    if (!cur) return;
    cur.aEnd = cur.aStart + cur.a.length - 1;
    cur.bEnd = cur.bStart + cur.b.length - 1;
    hunks.push(cur);
    cur = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) {
      open(i, j);
      cur.b.push(B[j++]);
    } else {
      open(i, j);
      cur.a.push(A[i++]);
    }
  }
  close();
  return hunks;
}

// The evidence, question and requirement IDs a piece of text mentions.
export function idsInText(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\[(?:(spec|brd) )?([EQ]\d+)\]|^\|\s*([EQ]\d+)\s*\||\b(BR-\d{2,})\b|\b([A-Z][A-Z0-9-]*-R\d{2,})\b|^- \*\*(Q\d+)\*\*/gm)) {
    if (m[2]) out.add(m[1] ? `${m[1]} ${m[2]}` : m[2]);
    else out.add(m[3] || m[4] || m[5] || m[6]);
  }
  return [...out];
}
