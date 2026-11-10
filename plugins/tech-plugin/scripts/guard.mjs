#!/usr/bin/env node
// tech-plugin guard: PreToolUse hook on EVERY tool call.
//
// Node.js, no dependencies, so it runs the same on macOS and Windows.
// FAIL-CLOSED: a crash, a timeout, unreadable input, or a call the guard cannot
// understand blocks the call. hooks.json runs it as `node guard.mjs || exit 2`,
// so a missing node, or any exit code other than 0/2, blocks too.
//
// Decisions:
//   pass  -> exit 0, no output. Claude Code's normal permissions still apply:
//            the guard never answers "allow", so it never auto-approves.
//   block -> exit 2, "tech-plugin: BLOCKED [<rule>] <reason>" on stderr.
//   ask   -> exit 0, permissionDecision "ask" (the person must confirm).
//
// Rules (letters as in the README): a secrets, b repo-write, c git, d installs,
// e prod-hosts, f zoho, g self-protection, h personal data (TODO, later step).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Block, setDeadline } from './lib/core.mjs';
import { exists, isDir, resolvePath } from './lib/paths.mjs';
import { projectConfigPath } from './lib/config.mjs';
import {
  braceAlternatives, checkWrite, hostHit, isSecretName, isSecretPath, makeCtx, secretsUnder, textNamesSecret, zohoDecision,
} from './lib/rules.mjs';
import { checkBash } from './lib/bash.mjs';

// Well under Claude Code's hook timeout (15 s in hooks.json): a hook that times
// out lets the call through, so the guard must decide first.
const TIME_BUDGET_MS = 2500;

function write(fd, s) {
  try {
    fs.writeSync(fd, s);
  } catch {
    /* nothing more we can do */
  }
}

function blockExit(rule, msg) {
  write(2, `tech-plugin: BLOCKED [${rule}] ${msg}\n`);
  process.exit(2);
}

process.on('uncaughtException', (e) => blockExit('internal', `guard error (${e && e.message}); blocking because the guard is fail-closed`));
process.on('unhandledRejection', (e) => blockExit('internal', `guard error (${e && e.message}); blocking because the guard is fail-closed`));

function main() {
  setDeadline(TIME_BUDGET_MS);
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    throw new Block('parse', 'could not read the hook input');
  }
  if (!raw.trim()) throw new Block('parse', 'empty hook input');
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Block('parse', 'the hook input is not valid JSON');
  }
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) {
    throw new Block('parse', 'the hook input has no tool_name');
  }
  const ti = input.tool_input === undefined ? {} : input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) throw new Block('parse', 'tool_input is not an object');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = resolvePath(process.env.CLAUDE_PLUGIN_ROOT || path.join(here, '..'), '/');
  const ctx = makeCtx(input, pluginRoot);

  if (ctx.baseErrors.length) handleBrokenConfig(ctx, input.tool_name, ti);
  else handle(ctx, input.tool_name, ti);

  if (ctx.asks.length) {
    write(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: [...new Set(ctx.asks)].join(' '),
      },
    }) + '\n');
  }
  process.exit(0);
}

// A broken sdlc-docs/config.json may hide project restrictions, so everything
// in that repo blocks except reading or fixing the file itself (fixing asks).
function handleBrokenConfig(ctx, tool, ti) {
  const fp = typeof ti.file_path === 'string' ? resolvePath(ti.file_path, ctx.cwd) : null;
  for (const { repo, error } of ctx.baseErrors) {
    if (fp && fp.toLowerCase() === projectConfigPath(repo).toLowerCase()) {
      if (tool === 'Read') return;
      if (['Edit', 'Write', 'MultiEdit'].includes(tool)) {
        ctx.ask(`tech-plugin: fixing ${error}. Confirm this change.`);
        return;
      }
    }
    throw new Block('config', `${error}; fix that file by hand (the guard blocks until it is valid JSON)`);
  }
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const SHELL_TOOL = /^(powershell|pwsh|cmd)$|(^|_)(powershell|run_shell|shell_exec|terminal_exec|execute_command|run_command|exec_command)$/i;
const BROWSER_TOOL = /playwright|browser|chrome|puppeteer|selenium|devtools/i;
const FETCH_TOOL = /^WebFetch$|(^|_)(fetch|web_fetch|http_request|fetch_url)$/i;
const WRITE_ACTION = /(create|write|edit|replace|insert|delete|remove|rename|move|update|patch|save|append|mkdir|apply|overwrite|modify)/i;
const PATH_KEY = /path|file|dir|cwd|uri|folder|target|source|dest/i;

function handle(ctx, tool, ti) {
  if (tool === 'Bash' || (tool === 'Monitor' && typeof ti.command === 'string')) return checkBash(ti.command, ctx);
  if (SHELL_TOOL.test(tool.split('__').pop())) throw new Block('parse', `${tool} commands cannot be checked by the guard; use Bash`);
  if (FILE_TOOLS.has(tool)) return fileTool(ctx, tool, ti);
  if (tool === 'Grep') return grepTool(ctx, ti);
  if (tool === 'Glob') return globTool(ctx, ti);

  const z = zohoDecision(tool);
  if (z === 'block') throw new Block('zoho', `${tool} changes a Zoho app other than Zoho Sprints; only Zoho Sprints is used here`);
  if (z === 'ask') {
    ctx.ask(`tech-plugin [zoho]: Zoho Sprints change (${tool.split('__').pop()}). Confirm before it runs.`);
    return null;
  }
  if (z === 'pass') return null;

  const action = tool.split('__').pop();
  const browserish = BROWSER_TOOL.test(tool);
  if (browserish || FETCH_TOOL.test(action)) {
    const h = hostHit(JSON.stringify(ti), ctx);
    if (h) throw new Block('prod-hosts', `${tool} targets production host ${h}; use staging`);
  }
  return genericTool(ctx, tool, ti, !browserish && WRITE_ACTION.test(action));
}

function fileTool(ctx, tool, ti) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (typeof fp !== 'string' || !fp) throw new Block('parse', `${tool} call without a file path`);
  const p = resolvePath(fp, ctx.cwd);
  if (isSecretName(fp, ctx) || isSecretPath(p, ctx)) {
    throw new Block('secrets', `${p} is a secret file (${path.basename(p)}); secret files are never read, searched or changed (.env.example is fine)`);
  }
  if (tool === 'Read' || tool === 'NotebookRead') return null;
  return checkWrite(p, ctx, { verb: tool });
}

// ripgrep --type names -> globs. Unknown type: "*" (could match anything, so fail-closed).
const TYPES = {
  php: '*.php *.php3 *.php4 *.php5 *.phtml', js: '*.js *.jsx *.mjs *.cjs *.vue', ts: '*.ts *.tsx *.cts *.mts',
  dart: '*.dart', json: '*.json *.jsonl *.json5 *.sarif', css: '*.css *.scss *.sass *.less', html: '*.html *.htm *.ejs',
  md: '*.md *.markdown *.mdx', markdown: '*.md *.markdown *.mdx', py: '*.py *.pyi', sh: '*.sh *.bash *.zsh',
  yaml: '*.yaml *.yml', sql: '*.sql', swift: '*.swift', kotlin: '*.kt *.kts', java: '*.java', go: '*.go',
  rust: '*.rs', ruby: '*.rb *.rake *.gemspec', c: '*.c *.h', cpp: '*.cpp *.cc *.cxx *.hpp *.hh *.h', cs: '*.cs',
  xml: '*.xml *.xsd *.xsl', txt: '*.txt', vue: '*.vue', svelte: '*.svelte', blade: '*.blade.php',
};

function globHits(file, root, pats) {
  const rel = path.relative(root, file).split(path.sep).join('/').toLowerCase();
  const base = path.basename(file).toLowerCase();
  for (let pat of pats) {
    pat = pat.toLowerCase().replace(/^(\*\*\/)+/, '');
    if (pat === '*' || pat === '**') return true;
    let re = '^';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '*' && pat[i + 1] === '*') {
        re += '.*';
        i++;
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const rx = new RegExp(re + '$');
    if (pat.includes('/') ? rx.test(rel) || new RegExp('(^|/)' + re.slice(1) + '$').test(rel) : rx.test(base)) return true;
  }
  return false;
}

function grepTool(ctx, ti) {
  const given = typeof ti.path === 'string' && ti.path ? ti.path : ctx.cwd;
  const p = resolvePath(given, ctx.cwd);
  const glob = typeof ti.glob === 'string' ? ti.glob : '';
  const type = typeof ti.type === 'string' ? ti.type : '';
  if (isSecretName(given, ctx) || isSecretPath(p, ctx)) throw new Block('secrets', `Grep path ${p} is a secret file`);
  if (glob && textNamesSecret(glob, ctx)) throw new Block('secrets', `Grep glob '${glob}' targets secret files`);
  const mode = ti.output_mode;
  // names-only modes never print file contents
  if (mode === undefined || mode === '' || mode === 'files_with_matches' || mode === 'count') return null;
  if (!isDir(p)) return null;
  const secrets = secretsUnder(p, ctx);
  if (!secrets.length) return null;
  const globPats = glob ? (glob.startsWith('!') ? ['*'] : braceAlternatives(glob)) : null;
  const typePats = type ? (TYPES[type.toLowerCase()] || '*').split(' ') : null;
  for (const s of secrets) {
    let hit = true;
    if (globPats && !globHits(s, p, globPats)) hit = false;
    if (typePats && !globHits(s, p, typePats)) hit = false;
    if (hit) {
      throw new Block('secrets', `a content Grep in ${p} would read secret file ${s}; use output_mode files_with_matches, a narrower path, or a glob/type that leaves it out`);
    }
  }
  return null;
}

function globTool(ctx, ti) {
  const pat = typeof ti.pattern === 'string' ? ti.pattern : '';
  if (pat && textNamesSecret(pat, ctx)) throw new Block('secrets', `Glob pattern '${pat}' targets secret files`);
  if (typeof ti.path === 'string' && ti.path && (isSecretName(ti.path, ctx) || isSecretPath(resolvePath(ti.path, ctx.cwd), ctx))) {
    throw new Block('secrets', `Glob path ${ti.path} is a secret file`);
  }
  return null; // Glob only returns names, never contents
}

// Any other tool (MCP servers, LSP, future tools): arguments that are paths are
// checked for secrets; tools whose name says they change things get the write checks.
function genericTool(ctx, tool, ti, writes) {
  const cands = [];
  let budget = 2000;
  const walk = (v, key, depth) => {
    if (--budget < 0 || depth > 6) return;
    if (typeof v === 'string') {
      if (PATH_KEY.test(key)) cands.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(ti, '', 0);
  for (let s of cands) {
    if (!s) continue;
    if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
    else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue;
    if (isSecretName(s, ctx)) throw new Block('secrets', `${tool} names secret file '${path.basename(s)}'`);
    if (s.length > 4096 || s.includes('\n')) continue;
    // MCP servers (Serena...) take paths relative to the project root.
    const p = resolvePath(s, tool.startsWith('mcp__') ? ctx.projectDir : ctx.cwd);
    if (exists(p) && isSecretPath(p, ctx)) throw new Block('secrets', `${tool} path ${s} points to secret file ${p}`);
    if (writes) checkWrite(p, ctx, { verb: tool });
  }
  return null;
}

try {
  main();
} catch (e) {
  if (e instanceof Block) blockExit(e.rule, e.message);
  blockExit('internal', `guard error (${e && e.message}); blocking because the guard is fail-closed`);
}
