// graphify code graph: build (breakdown stage 3) and read (stage 5 and later
// commands: impact, task, incident).
//
// How it is built, and why:
//   - graphify runs code-only and offline: GRAPHIFY_BACKEND=none, `extract
//     --code-only`, then `cluster-only --no-viz --no-label`. No AI calls, no
//     network.
//   - It runs on a TEMPORARY COPY of the repo's code files, made with the
//     guard's secret-name rules. graphify has its own list of sensitive files,
//     but a project can name more (for example a Dart file holding keys);
//     graphify does not follow symlinks, and hard links would trip the
//     guard's hard-link check, so real copies it is. The repo itself is never
//     written to.
//   - Only graph.json, GRAPH_REPORT.md, a small communities.json summary and
//     stamp.json (commit + code fingerprint) are kept, in
//     <repo>/sdlc-docs/_map/graphify/<repo>/. The graph is rebuilt only when
//     the stamp changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const GRAPH_EXT = /\.(php|dart|js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|java|kt|kts|rb|cs|rs|swift|c|h|cpp|cc|hpp|m|mm|scala|ex|exs|lua)$/i;
const MAX_FILE = 1024 * 1024;

export function findGraphify(env = process.env) {
  if (env.TECH_PLUGIN_GRAPHIFY) return fs.existsSync(env.TECH_PLUGIN_GRAPHIFY) ? env.TECH_PLUGIN_GRAPHIFY : null;
  for (const d of (env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const n of process.platform === 'win32' ? ['graphify.exe', 'graphify.cmd', 'graphify'] : ['graphify']) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function run(bin, args, opts) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error.message) : ''), timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

// Builds the graph for one repo. `files` = repo-relative files already
// filtered for secrets and dependency folders. `write(rel, content)` writes
// below the repo's sdlc-docs/ (relative to it).
export function buildGraph({ repo, name, files, outRel, stamp, force = false, bin = findGraphify(), timeoutMs = 15 * 60 * 1000, write, readStamp }) {
  if (!bin) return { status: 'missing', message: 'graphify is not installed: the code graph was skipped (see /tech-plugin:doctor for the install command)' };
  const old = readStamp();
  if (!force && old && old.commit === stamp.commit && old.tree === stamp.tree && old.status === 'built') return { ...old, status: 'up-to-date' };
  const code = files.filter((f) => GRAPH_EXT.test(f));
  if (!code.length) return { status: 'empty', message: 'no code files for the graph' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-graph-'));
  try {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    let copied = 0;
    for (const f of code) {
      const from = path.join(repo, f);
      let st;
      try {
        st = fs.lstatSync(from);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const to = path.join(srcDir, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied++;
    }
    const env = { ...process.env, GRAPHIFY_BACKEND: 'none' };
    const t0 = Date.now();
    const ex = run(bin, ['extract', srcDir, '--code-only', '--out', outDir], { cwd: srcDir, env, timeout: timeoutMs });
    const clean = (t) => t.split(tmp).join('<temp copy>').split('\n').slice(-6).join('\n').trim();
    if (ex.code !== 0) return { status: 'failed', message: ex.timedOut ? `graphify extract took longer than ${Math.round(timeoutMs / 60000)} minutes` : `graphify extract failed: ${clean(ex.err || ex.out)}` };
    const cl = run(bin, ['cluster-only', outDir, '--no-viz', '--no-label'], { cwd: outDir, env, timeout: timeoutMs });
    const g = path.join(outDir, 'graphify-out', 'graph.json');
    if (!fs.existsSync(g)) return { status: 'failed', message: 'graphify wrote no graph.json' };
    const graphText = fs.readFileSync(g, 'utf8');
    let graph;
    try {
      graph = JSON.parse(graphText);
    } catch {
      return { status: 'failed', message: 'graphify wrote a graph.json that is not valid JSON' };
    }
    write(path.join(outRel, 'graph.json'), graphText);
    const rep = path.join(outDir, 'graphify-out', 'GRAPH_REPORT.md');
    if (fs.existsSync(rep)) write(path.join(outRel, 'GRAPH_REPORT.md'), fs.readFileSync(rep, 'utf8').split(tmp).join('.'));
    const comms = communities(graph);
    write(path.join(outRel, 'communities.json'), JSON.stringify({ repo: name, commit: stamp.commit, communities: comms }, null, 2) + '\n');
    const ver = run(bin, ['--version'], { timeout: 20000 }).out.trim().split('\n')[0] || null;
    const info = {
      status: 'built',
      repo: name,
      commit: stamp.commit,
      tree: stamp.tree,
      builtAt: new Date().toISOString(),
      graphify: ver,
      filesCopied: copied,
      nodes: (graph.nodes || []).length,
      edges: (graph.links || graph.edges || []).length,
      communities: comms.length,
      seconds: Math.round((Date.now() - t0) / 1000),
      clustered: cl.code === 0,
    };
    write(path.join(outRel, 'stamp.json'), JSON.stringify(info, null, 2) + '\n');
    return info;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ reading

export function loadGraph(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const dirOf = (f, depth) => f.split('/').slice(0, -1).slice(0, depth).join('/') || '.';

// One row per community: size, its files, the folder most of them share and
// the most connected symbols (hubs).
export function communities(graph, { maxFiles = 12, maxHubs = 6 } = {}) {
  const nodes = graph.nodes || [];
  const links = graph.links || graph.edges || [];
  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  const by = new Map();
  for (const n of nodes) {
    const c = n.community === undefined || n.community === null ? -1 : n.community;
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(n);
  }
  const out = [];
  for (const [id, ns] of by) {
    if (id === -1) continue;
    const files = new Map();
    for (const n of ns) if (n.source_file) files.set(n.source_file, (files.get(n.source_file) || 0) + 1);
    const fl = [...files.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const folders = new Map();
    for (const [f, c] of fl) {
      const d = dirOf(f, 3);
      folders.set(d, (folders.get(d) || 0) + c);
    }
    const folder = [...folders.entries()].sort((a, b) => b[1] - a[1])[0];
    const hubs = ns
      .filter((n) => n.label && !/^\.?[\w$]+\(\)$/.test(n.label) || /^[A-Z]/.test(n.label || ''))
      .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
      .slice(0, maxHubs)
      .map((n) => n.label);
    out.push({ id: `c${id}`, size: ns.length, files: fl.slice(0, maxFiles).map(([f]) => f), fileCount: fl.length, folder: folder ? folder[0] : null, hubs });
  }
  return out.sort((a, b) => b.size - a.size);
}

// file -> community id it mostly belongs to
export function fileCommunities(graph) {
  const count = new Map();
  for (const n of graph.nodes || []) {
    if (!n.source_file || n.community === undefined || n.community === null) continue;
    const k = n.source_file;
    if (!count.has(k)) count.set(k, new Map());
    const m = count.get(k);
    m.set(n.community, (m.get(n.community) || 0) + 1);
  }
  const out = new Map();
  for (const [f, m] of count) out.set(f, `c${[...m.entries()].sort((a, b) => b[1] - a[1])[0][0]}`);
  return out;
}
