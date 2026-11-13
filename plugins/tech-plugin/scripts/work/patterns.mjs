// Patterns shared by the plan checks (check-work.mjs) and the test checks
// (tests.mjs): commands the guard would block, and test files.

import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade)\b|\bcomposer\s+(install|require|update)\b|\bpip3?\s+install\b|\b(poetry|pipenv|uv)\s+(add|install|sync)\b|\b(flutter|dart)\s+pub\s+(get|add|upgrade)\b|\bpod\s+install\b|\bgem\s+install\b|\bbundle\s+install\b|\bgo\s+(get|mod\s+download)\b|\bcargo\s+(add|install)\b/i;
export const GIT_WRITE_RE = /\bgit\s+(?!(diff|status|log|show|grep|blame|ls-files|rev-parse)\b)\w+/i;
export const TEST_FILE_RE = /(^|\/)(tests?|spec|specs|__tests__|test_driver|integration_test)\/|[._-](test|spec)\.[a-z]+$|Test\.(php|java|kt)$|_test\.(go|dart|py)$/i;

// A framework command the guard's safe-command list blocks (php artisan test,
// python manage.py test, rails test…): the reason, with the runner to use
// instead, or null. The guard allows only the listed subcommands of these.
const DIRECT = { 'php artisan': 'vendor/bin/phpunit or vendor/bin/pest', 'python manage.py': 'pytest', rails: 'bin/rails is limited: use bundle exec rspec', rake: 'bundle exec rspec' };
export function safeCommandBlocked(cmd, pluginRoot) {
  let safe = {};
  try {
    safe = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config', 'defaults.json'), 'utf8')).safeCommands || {};
  } catch {
    return null;
  }
  for (const [tool, subs] of Object.entries(safe)) {
    if (tool.startsWith('_') || !Array.isArray(subs)) continue;
    for (const m of String(cmd).matchAll(new RegExp(`(?:^|[;&|]\\s*|\\s)${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\s+(\\S+)`, 'g'))) {
      if (!subs.includes(m[1])) return `the guard allows "${tool}" only with ${subs.join(', ')}; run the tests with ${DIRECT[tool] || 'the test runner directly'}`;
    }
  }
  return null;
}
