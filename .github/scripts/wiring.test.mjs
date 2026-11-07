// The files that decide what the review model can reach, checked as written and
// against deliberately broken copies, which must fail.
//
// Run with: node --test .github/scripts/wiring.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { agentViolations, parseFrontmatter, workflowSteps, workflowViolations } from './wiring-check.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const WORKFLOW = read('../workflows/review.yml');
const AGENT = read('../../.opencode/agent/kinsho-review.md');
const PLUGIN = read('../../.opencode/plugins/kinsho-guard.js');

test('the agent file is default-deny with only the three script patterns allowed', () => {
  assert.deepEqual(agentViolations(AGENT), []);
  const permission = parseFrontmatter(AGENT).permission;
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.bash['*'], 'deny');
  assert.deepEqual(
    Object.entries(permission.bash).filter(([, rule]) => rule === 'allow').map(([pattern]) => pattern),
    [
      'node .kinsho/.github/scripts/kinsho-gh.mjs *',
      'node .kinsho/.github/scripts/kinsho-exec.mjs test',
      'node .kinsho/.github/scripts/kinsho-exec.mjs check'
    ]
  );
  for (const tool of ['edit', 'write', 'patch']) assert.notEqual(permission[tool], 'allow');
  // Nothing that could push, publish or install is on the list.
  assert.ok(!AGENT.match(/^\s+"(?:git|curl|wget|rm|pnpm|npm|gh)\b/m));
});

test('negative fixture: an agent file that allows bash "*" fails the check', () => {
  const broken = AGENT.replace('    "*": deny\n    "node', '    "*": allow\n    "node');
  assert.notEqual(broken, AGENT);
  assert.match(agentViolations(broken).join('\n'), /bash "\*" must be deny/);

  const flat = AGENT.replace(/  bash:\n(?:    .*\n)+/, '  bash: allow\n');
  assert.match(agentViolations(flat).join('\n'), /bash must be a pattern map/);
});

test('negative fixtures: other ways to widen the agent also fail', () => {
  const cases = [
    [AGENT.replace('  "*": deny\n  read', '  "*": allow\n  read'), /permission "\*" must be deny/],
    [AGENT.replace('  read: allow', '  read: allow\n  edit: allow'), /edit must not be allowed/],
    [AGENT.replace('  read: allow', '  read: allow\n  write: allow'), /write must not be allowed/],
    [AGENT.replace('  read: allow', '  read: allow\n  patch: allow'), /patch must not be allowed/],
    [AGENT.replace('  read: allow', '  read: allow\n  task: allow'), /task must not be allowed/],
    [AGENT.replace('  read: allow', '  read: allow\n  websearch: allow'), /websearch is allowed but is not an approved tool/],
    [AGENT.replace('    "node .kinsho/.github/scripts/kinsho-exec.mjs check": allow', '    "git push *": allow'), /"git push \*" is not on the allowlist/],
    [AGENT.replace('    "node .kinsho/.github/scripts/kinsho-exec.mjs check": allow', '    "node .kinsho/.github/scripts/kinsho-exec.mjs *": allow'), /kinsho-exec\.mjs \*" is not on the allowlist/],
    [AGENT.replace('    "node .kinsho/.github/scripts/kinsho-exec.mjs check": allow', '    "gh api *": allow'), /"gh api \*" is not on the allowlist/],
    ['no front matter here', /no permission block/]
  ];
  for (const [text, pattern] of cases) assert.match(agentViolations(text).join('\n'), pattern, String(pattern));
});

test('the workflow keeps production secrets and write access away from the model', () => {
  assert.deepEqual(workflowViolations(WORKFLOW), []);
});

test('negative fixture: a workflow that leaks a production secret into the review step fails', () => {
  const leaks = [
    ['CLOUDFLARE_API_TOKEN', /secret CLOUDFLARE_API_TOKEN is production-scoped/],
    ['NEON_API_KEY', /secret NEON_API_KEY is production-scoped/],
    ['DATABASE_URL', /secret DATABASE_URL is production-scoped/],
    ['PROD_DEPLOY_KEY', /secret PROD_DEPLOY_KEY is production-scoped/]
  ];
  for (const [name, pattern] of leaks) {
    const broken = WORKFLOW.replace(
      '          KINSHO_MODEL: ${{ steps.model.outputs.model }}',
      `          ${name}: \${{ secrets.${name} }}\n          KINSHO_MODEL: \${{ steps.model.outputs.model }}`
    );
    assert.notEqual(broken, WORKFLOW);
    const found = workflowViolations(broken).join('\n');
    assert.match(found, pattern, name);
    assert.match(found, /the model step must not see secret/);
  }
});

test('negative fixtures: write tokens, inherited secrets and pull_request_target fail', () => {
  const cases = [
    [WORKFLOW.replace('GH_TOKEN: ${{ steps.read-token.outputs.token }}\n          KINSHO_COMMAND_DIR', 'GH_TOKEN: ${{ steps.app-token.outputs.token }}\n          KINSHO_COMMAND_DIR'), /GH_TOKEN must be the read-only token/],
    [WORKFLOW.replace('permission-actions: read', 'permission-actions: write'), /permission actions is write/],
    [WORKFLOW.replace('permission-contents: read\n          permission-pull-requests: read\n          permission-issues: read', 'permission-contents: read\n          permission-pull-requests: write\n          permission-issues: read'), /permission pull-requests is write/],
    [WORKFLOW.replace('uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.repository.default_branch }}', 'secrets: inherit\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.repository.default_branch }}'), /secrets: inherit/],
    [WORKFLOW.replace('on:\n  workflow_call:', 'on:\n  pull_request_target:\n  workflow_call:'), /pull_request_target/],
    [WORKFLOW.replace('secrets.OPENCODE_API_KEY }}\n          GH_TOKEN', 'secrets.GITHUB_PAT }}\n          GH_TOKEN'), /secret GITHUB_PAT is not one of/]
  ];
  for (const [text, pattern] of cases) {
    assert.notEqual(text, WORKFLOW, String(pattern));
    assert.match(workflowViolations(text).join('\n'), pattern, String(pattern));
  }
});

test('the model step gets a read-only token, and the write token stays with later steps', () => {
  const steps = workflowSteps(WORKFLOW);
  const read = steps.find((step) => step.id === 'read-token');
  assert.deepEqual(
    [...read.body.matchAll(/permission-([a-z-]+): (\w+)/g)].map(([, name, level]) => `${name}:${level}`).sort(),
    ['actions:read', 'checks:read', 'contents:read', 'issues:read', 'pull-requests:read']
  );
  const run = steps.find((step) => step.name === 'Run Kinsho review');
  assert.ok(run.body.includes('GH_TOKEN: ${{ steps.read-token.outputs.token }}'));
  assert.ok(!run.body.includes('app-token'));
  const writers = steps.filter((step) => step.body.includes('steps.app-token.outputs.token')).map((step) => step.name);
  assert.ok(writers.length > 0);
  assert.ok(!writers.includes('Run Kinsho review'));
  assert.ok(!writers.includes('Install opencode'));
});

test('commands run only after the sandbox is prepared, and their text is fixed before the model starts', () => {
  const order = ['Check out PR head for commands', 'Prepare command sandbox', 'Install opencode', 'Run Kinsho review'].map((name) =>
    WORKFLOW.indexOf(`- name: ${name}`)
  );
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const prepare = workflowSteps(WORKFLOW).find((step) => step.name === 'Prepare command sandbox');
  assert.match(prepare.body, /printf '%s' "\$TEST_COMMAND"/);
  assert.match(prepare.body, /sudo useradd/);
  // The PR checkout carries no credentials, and nothing reads the PR's package.json
  // to decide what a command is: the command text is the caller's input.
  const checkout = workflowSteps(WORKFLOW).find((step) => step.name === 'Check out PR head for commands');
  assert.match(checkout.body, /persist-credentials: false/);
  assert.ok(!/package\.json/.test(WORKFLOW));
  assert.match(WORKFLOW, /inputs\.run_commands && \(inputs\.test_command != '' \|\| inputs\.check_command != ''\)/);
});

test('the prompt is built after the sandbox, so it tells the model whether commands can run', () => {
  const prompt = WORKFLOW.indexOf('- name: Build review prompt');
  assert.ok(prompt > WORKFLOW.indexOf('- name: Prepare command sandbox'));
  assert.ok(prompt < WORKFLOW.indexOf('- name: Run Kinsho review'));
  assert.match(WORKFLOW, /COMMANDS_ENABLED: \$\{\{ steps\.sandbox\.outcome == 'success' \}\}/);
});

test('run_commands is a boolean input that defaults on', () => {
  assert.match(WORKFLOW, /^ {6}run_commands:\n(?: {8}.+\n)*? {8}type: boolean\n {8}required: false\n {8}default: true$/m);
});

test('the guard plugin is installed next to the agent and uses the shared policy', () => {
  assert.match(WORKFLOW, /cp \.kinsho\/\.opencode\/plugins\/kinsho-guard\.js \.opencode\/plugins\/kinsho-guard\.js/);
  assert.match(PLUGIN, /checkBashCommand/);
  assert.match(PLUGIN, /checkWebfetchUrl/);
  assert.match(PLUGIN, /'tool\.execute\.before'/);
  assert.match(PLUGIN, /throw new Error/);
});

test('the model does not start unless the guard plugin is loaded, and the scripts are read-only', () => {
  const install = workflowSteps(WORKFLOW).find((step) => step.name === 'Install opencode');
  assert.match(install.body, /opencode debug config \| grep -q 'plugins\/kinsho-guard\\\.js'/);
  assert.match(install.body, /exit 1/);
  assert.match(install.body, /chmod -R a-w \.kinsho/);
  assert.ok(install.body.indexOf('debug config') < install.body.indexOf('chmod'));
});

test('the post steps refuse a comment that carries a credential', () => {
  for (const name of ['Post review comment', 'Report automation failure']) {
    const step = workflowSteps(WORKFLOW).find((s) => s.name === name);
    assert.match(step.body, /LEAK_OPENCODE_API_KEY: \$\{\{ secrets\.OPENCODE_API_KEY \}\}/, name);
    assert.match(step.body, /LEAK_READ_TOKEN/, name);
    assert.match(step.body, /LEAK_WRITE_TOKEN/, name);
  }
});
