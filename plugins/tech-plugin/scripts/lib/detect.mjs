// Detection logic for doctor: which languages a folder uses (from its manifest
// files) and which official LSP plugin to recommend for each. Pure functions on
// a folder listing, so tests can run them on fake folders.

import fs from 'node:fs';
import path from 'node:path';

export const MARKETPLACE = 'claude-plugins-official';

// One rule per language. `files` are matched against the folder's entries
// (case-insensitive); a RegExp entry matches names like requirements-dev.txt.
export const LSP_RULES = [
  { lang: 'PHP', files: ['composer.json'], plugin: 'php-lsp' },
  { lang: 'TypeScript / JavaScript', files: ['package.json', 'tsconfig.json', 'jsconfig.json'], plugin: 'typescript-lsp' },
  { lang: 'Python', files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', /^requirements([-_.].*)?\.txt$/i, 'requirements'], plugin: 'pyright-lsp' },
  { lang: 'Go', files: ['go.mod'], plugin: 'gopls-lsp' },
  { lang: 'Java / Kotlin', files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], plugin: 'jvm' },
  {
    lang: 'Dart / Flutter',
    files: ['pubspec.yaml'],
    plugin: null,
    note: `no official Dart LSP plugin; consider Serena (/plugin install serena@${MARKETPLACE})`,
  },
];

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function matches(entries, files) {
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  return files.some((f) => (f instanceof RegExp ? entries.some((e) => f.test(e)) : lower.has(f.toLowerCase())));
}

// Gradle builds written in Kotlin, or with the Kotlin plugin, get kotlin-lsp;
// plain Maven/Gradle Java gets jdtls-lsp.
export function jvmPlugin(dir, entries) {
  const names = entries.map((e) => e.toLowerCase());
  if (names.includes('build.gradle.kts') || names.includes('settings.gradle.kts')) return 'kotlin-lsp';
  for (const f of ['build.gradle', 'pom.xml']) {
    const real = entries.find((e) => e.toLowerCase() === f);
    if (!real) continue;
    try {
      const text = fs.readFileSync(path.join(dir, real), 'utf8').slice(0, 200000);
      if (/kotlin/i.test(text)) return 'kotlin-lsp';
    } catch {
      /* unreadable: fall through */
    }
  }
  return 'jdtls-lsp';
}

// [{ lang, plugin, note, evidence }] for the folder (only the folder itself is read).
export function detectLanguages(dir) {
  const entries = listDir(dir);
  const out = [];
  for (const r of LSP_RULES) {
    if (!matches(entries, r.files)) continue;
    const evidence = entries.filter((e) => r.files.some((f) => (f instanceof RegExp ? f.test(e) : f.toLowerCase() === e.toLowerCase())));
    const plugin = r.plugin === 'jvm' ? jvmPlugin(dir, entries) : r.plugin;
    out.push({ lang: r.lang, plugin, note: r.note || null, evidence });
  }
  return out;
}

// Installed plugin ids ("name@marketplace") from Claude Code's own record.
export function installedPlugins(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    return new Set(Object.keys(j.plugins || {}));
  } catch {
    return new Set();
  }
}

export function installCommand(plugin) {
  return `/plugin install ${plugin}@${MARKETPLACE}`;
}

// Warning text when CLAUDE_CODE_EFFORT_LEVEL is set, else null.
export function effortWarning(env) {
  const v = env.CLAUDE_CODE_EFFORT_LEVEL;
  if (!v) return null;
  return `CLAUDE_CODE_EFFORT_LEVEL=${v} is set: it overrides the effort of every tech-plugin command. Unset it unless you mean that.`;
}
