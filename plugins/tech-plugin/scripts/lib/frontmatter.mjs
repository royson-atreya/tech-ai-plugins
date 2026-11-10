// Document stamps: YAML front matter between --- lines at the top of a
// document, in the strict YAML subset of lib/yaml.mjs.

import crypto from 'node:crypto';
import { parseYaml, toYaml } from './yaml.mjs';

export function splitDoc(text) {
  const t = String(text).replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { front: null, frontText: null, body: t, frontLines: 0 };
  return { front: parseYaml(m[1]), frontText: m[1], body: t.slice(m[0].length), frontLines: m[0].split('\n').length - 1 };
}

export function joinDoc(front, body) {
  return `---\n${toYaml(front).trimEnd()}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

// The hash of what a document SAYS: its body, without the stamp, so a
// sign-off written into the stamp does not change it.
export function bodyHash(body) {
  return crypto.createHash('sha1').update(String(body).replace(/[ \t]+$/gm, '').trim()).digest('hex').slice(0, 16);
}

export function textHash(text) {
  return bodyHash(splitDoc(text).body);
}
