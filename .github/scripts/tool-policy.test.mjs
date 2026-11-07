// What the review model may run: the bash and webfetch gates, the gh argument
// allowlist, the command sandbox and the leak check. The bypass cases here are
// the ones a planted instruction would try.
//
// Run with: node --test .github/scripts/tool-policy.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  capOutput,
  checkBashCommand,
  checkWebfetchUrl,
  findLeak,
  sandboxArgv,
  splitWords,
  validateGhArgs
} from './tool-policy.mjs';

const G = 'node .kinsho/.github/scripts/kinsho-gh.mjs';
const E = 'node .kinsho/.github/scripts/kinsho-exec.mjs';
const GH_SCRIPT = fileURLToPath(new URL('./kinsho-gh.mjs', import.meta.url));
const EXEC_SCRIPT = fileURLToPath(new URL('./kinsho-exec.mjs', import.meta.url));

test('bash: the two scripts with plain or single-quoted words pass', () => {
  for (const command of [
    `${G} api repos/o/r/environments/production`,
    `${G} api repos/o/r/pulls/3/files --jq '.[].filename'`,
    `${G} api repos/o/r/branches/main/protection -X GET`,
    `${G} pr view 12 --json files,statusCheckRollup`,
    `${G} run view 123456789 --log-failed`,
    `${E} test`,
    `${E} check`
  ]) {
    assert.equal(checkBashCommand(command).ok, true, command);
  }
  assert.equal(checkBashCommand(`${G} api repos/o/r`).script, 'kinsho-gh');
  assert.equal(checkBashCommand(`${E} test`).script, 'kinsho-exec');
});

test('bash: chaining, pipes, substitution, redirection and expansion are all rejected', () => {
  const bypasses = [
    `${G} api repos/o/r; touch x`,
    `${G} api repos/o/r && touch x`,
    `${G} api repos/o/r || touch x`,
    `${G} api repos/o/r | tee x`,
    `${G} api repos/o/r |& tee x`,
    `${G} api repos/o/r & touch x`,
    `${G} api repos/$(touch x)`,
    `${G} api repos/\`touch x\``,
    `${G} api "repos/$(touch x)"`,
    `${G} api repos/o/r > x`,
    `${G} api repos/o/r >> x`,
    `${G} api repos/o/r < /etc/passwd`,
    `${G} api repos/o/r 2>&1`,
    `${G} api repos/o/r <(touch x)`,
    `${G} api repos/o/{r,s}`,
    `${G} api repos/o/*`,
    `${G} api repos/o/r?`,
    `${G} api ~/x`,
    `${G} api repos/o/r\ntouch x`,
    `${G} api repos/o/r\rtouch x`,
    `${G} api repos/o/r\ttouch x`,
    `${G} api repos/o/r # comment`,
    `${G} api repos/o/r !history`,
    `${G} api "double quoted"`,
    `${G} api 'a'b`,
    `${G} api 'it'"'"'s'`,
    `${G} api $HOME`,
    `${G} api repos/o/r\\\ntouch x`,
    `X=1 ${G} api repos/o/r`,
    `./.kinsho/.github/scripts/kinsho-gh.mjs api repos/o/r`,
    `node ./.kinsho/.github/scripts/kinsho-gh.mjs api repos/o/r`,
    `node .kinsho/.github/scripts/../scripts/kinsho-gh.mjs api repos/o/r`,
    `node .kinsho/.github/scripts/kinsho-gh.mjs.evil api repos/o/r`,
    `node  .kinsho/.github/scripts/kinsho-gh.mjs api repos/o/r`,
    `sh -c "${G} api repos/o/r"`,
    `${E} test; touch x`,
    `${E} test && touch x`,
    `${E} test | cat`,
    `git push origin HEAD`,
    `git commit -am x`,
    `git checkout -b x`,
    `gh pr merge 1`,
    `gh api repos/o/r`,
    `curl https://example.com`,
    `wget https://example.com`,
    `rm -rf .`,
    `pnpm install`,
    `npm install x`,
    `printenv`,
    `env`,
    `cat .env`,
    `bash -c 'touch x'`,
    `node -e "1"`,
    '',
    '   ',
    undefined,
    null,
    42
  ];
  for (const command of bypasses) {
    assert.equal(checkBashCommand(command).ok, false, JSON.stringify(command));
  }
});

test('bash: the exec script is not given a command to run', () => {
  assert.equal(checkBashCommand(`${E} lint`).ok, true); // shape only; the script rejects the name
  const run = spawnSync(process.execPath, [EXEC_SCRIPT, 'lint'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage is test\|check/);
  const extra = spawnSync(process.execPath, [EXEC_SCRIPT, 'test', 'rm -rf /'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(extra.status, 2);
});

test('splitWords returns the words with quotes removed', () => {
  assert.deepEqual(splitWords(` api repos/o/r --jq '.[] | .name'`), ['api', 'repos/o/r', '--jq', '.[] | .name']);
});

test('gh: reads are accepted', () => {
  const ok = [
    ['api', 'repos/o/r/environments/production'],
    ['api', '/repos/o/r/pulls/3'],
    ['api', 'repos/o/r/pulls?state=open&per_page=5'],
    ['api', 'repos/o/r/actions/runs', '--paginate', '--jq', '.workflow_runs[].id'],
    ['api', '--method', 'GET', 'repos/o/r'],
    ['api', '-X', 'get', 'repos/o/r'],
    ['api', '--method=GET', 'repos/o/r'],
    ['api', 'repos/o/r/contents/README.md', '-H', 'Accept: application/vnd.github.raw'],
    ['pr', 'view', '12', '--json', 'files,commits'],
    ['pr', 'view', '12', '--comments'],
    ['pr', 'diff', '12', '--name-only'],
    ['pr', 'diff', '12', '--patch'],
    ['pr', 'checks', '12', '--json', 'name,state'],
    ['run', 'view', '4567', '--log'],
    ['run', 'view', '4567', '--log-failed'],
    ['run', 'view', '4567', '--job', '99', '--log']
  ];
  for (const argv of ok) assert.equal(validateGhArgs(argv).ok, true, argv.join(' '));
});

test('gh: anything that writes, or is not on the allowlist, is rejected', () => {
  const bad = [
    [],
    ['api'],
    ['api', 'graphql'],
    ['api', 'user'],
    ['api', 'repos/o/r', '-X', 'POST'],
    ['api', 'repos/o/r', '-X', 'DELETE'],
    ['api', 'repos/o/r', '--method', 'PATCH'],
    ['api', 'repos/o/r', '--method=PUT'],
    ['api', 'repos/o/r', '-XPOST'],
    ['api', 'repos/o/r', '-f', 'a=b'],
    ['api', 'repos/o/r', '-F', 'a=b'],
    ['api', 'repos/o/r', '--field', 'a=b'],
    ['api', 'repos/o/r', '--raw-field', 'a=b'],
    ['api', 'repos/o/r', '--field=a=b'],
    ['api', 'repos/o/r', '--input', 'x.json'],
    ['api', 'repos/o/r', '--hostname', 'evil.example'],
    ['api', 'repos/o/r', '-H', 'X-HTTP-Method-Override: DELETE'],
    ['api', 'repos/o/r', '-H', 'Authorization: token x'],
    ['api', 'repos/o/r', '-H', 'Accept: x\nX-HTTP-Method-Override: DELETE'],
    ['api', 'repos/o/r', '--paginate=false'],
    ['api', 'repos/o/r', 'repos/o/s'],
    ['api', 'repos/../../user'],
    ['api', 'repos/o/r/../../../user'],
    ['api', 'http://evil.example/repos/o/r'],
    ['api', '--jq'],
    ['pr', 'merge', '1'],
    ['pr', 'edit', '1', '--add-label', 'pr-ready'],
    ['pr', 'comment', '1', '--body', 'x'],
    ['pr', 'review', '1', '--approve'],
    ['pr', 'close', '1'],
    ['pr', 'view'],
    ['pr', 'view', 'main'],
    ['pr', 'view', '12', '--web'],
    ['pr', 'view', '12', '--repo', 'other/repo'],
    ['pr', 'checks', '12', '--watch'],
    ['run', 'view', '1', '--web'],
    ['run', 'view', '--log'],
    ['run', 'rerun', '1'],
    ['run', 'cancel', '1'],
    ['workflow', 'run', 'x.yml'],
    ['secret', 'list'],
    ['variable', 'set', 'A', '--body', 'b'],
    ['label', 'create', 'x'],
    ['issue', 'comment', '1'],
    ['repo', 'delete', 'o/r'],
    ['auth', 'token'],
    ['alias', 'set', 'x', 'y'],
    ['extension', 'install', 'x'],
    ['--version']
  ];
  for (const argv of bad) assert.equal(validateGhArgs(argv).ok, false, argv.join(' '));
  assert.equal(validateGhArgs(null).ok, false);
});

test('webfetch: only the documentation hosts, over plain https', () => {
  for (const url of [
    'https://docs.github.com/en/rest/branches/branch-protection',
    'https://developers.cloudflare.com/workers/',
    'https://neon.tech/docs/introduction',
    'https://neon.tech/docs',
    'https://orm.drizzle.team/docs/overview',
    'https://svelte.dev/docs/svelte/overview',
    'https://opencode.ai/docs/permissions/'
  ]) {
    assert.equal(checkWebfetchUrl(url).ok, true, url);
  }
  for (const url of [
    'https://evil.example/?data=1',
    'https://docs.github.com.evil.example/',
    'https://evil.example/docs.github.com',
    'https://docs.github.com@evil.example/',
    'https://user:pw@docs.github.com/',
    'https://docs.github.com:8443/',
    'http://docs.github.com/',
    'ftp://docs.github.com/',
    'file:///etc/passwd',
    'https://neon.tech/pricing',
    'https://neon.tech/docsx',
    'https://neon.tech/docs/../pricing',
    'https://opencode.ai/',
    'https://raw.githubusercontent.com/o/r/main/x',
    'https://github.com/o/r',
    'https://api.github.com/repos/o/r',
    'https://169.254.169.254/latest/meta-data',
    'docs.github.com',
    '',
    undefined
  ]) {
    assert.equal(checkWebfetchUrl(url).ok, false, String(url));
  }
});

test('sandbox: another user, an empty environment, and the command as data', () => {
  const argv = sandboxArgv({ command: 'pnpm test', user: 'kinsho-sbx', path: '/usr/bin:/bin' });
  assert.deepEqual(argv.slice(0, 5), ['sudo', '-n', '-u', 'kinsho-sbx', '--']);
  assert.deepEqual(argv.slice(5, 8), ['env', '-i', 'HOME=/home/kinsho-sbx']);
  assert.ok(argv.includes('timeout'));
  // The command is the final argument, never spliced into the shell script text.
  assert.equal(argv.at(-1), 'pnpm test');
  assert.ok(!argv.slice(0, -1).some((part) => part.includes('pnpm test')));
  // Only these variables are passed on; no token or key name appears at all.
  const vars = argv.filter((part) => /^[A-Z_]+=/.test(part)).map((part) => part.split('=')[0]);
  assert.deepEqual(vars, ['HOME', 'PATH', 'CI', 'LANG']);
  assert.ok(!argv.join(' ').match(/TOKEN|API_KEY|SECRET/));
});

test('sandbox: a hostile command string stays one argument', () => {
  const command = `x"; touch /tmp/pwned; echo "`;
  const argv = sandboxArgv({ command, user: 'u', path: '/bin' });
  assert.equal(argv.at(-1), command);
  assert.equal(argv.filter((part) => part.includes('touch')).length, 1);
});

function stubBin(files) {
  const dir = mkdtempSync(join(tmpdir(), 'kinsho-stub-'));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test('kinsho-gh passes gh only the validated args and a bare environment', () => {
  const bin = stubBin({ gh: 'echo "args: $*"; env | sort | grep -E "^(GH_|OPENCODE|SECRET|KINSHO)" || true' });
  const run = spawnSync(process.execPath, [GH_SCRIPT, 'api', 'repos/o/r', '--jq', '.id'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: '/tmp',
      GH_TOKEN: 'read-token-value',
      GITHUB_REPOSITORY: 'o/r',
      OPENCODE_API_KEY: 'api-key-value',
      SECRET_THING: 'nope'
    }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /args: api repos\/o\/r --jq \.id/);
  assert.match(run.stdout, /GH_TOKEN=read-token-value/);
  assert.match(run.stdout, /GH_REPO=o\/r/);
  assert.ok(!run.stdout.includes('api-key-value'));
  assert.ok(!run.stdout.includes('SECRET_THING'));
});

test('kinsho-gh does not start gh for a denied call', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'kinsho-m-')), 'ran');
  const bin = stubBin({ gh: `touch ${marker}` });
  for (const args of [['api', 'repos/o/r', '-X', 'POST'], ['pr', 'merge', '1'], ['api', 'repos/o/r', '-f', 'a=b']]) {
    const run = spawnSync(process.execPath, [GH_SCRIPT, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }
    });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /kinsho-gh: denied/);
  }
  const ran = spawnSync('test', ['-e', marker]);
  assert.notEqual(ran.status, 0, 'gh must not have run');
});

test('kinsho-exec runs the configured command through the sandbox and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinsho-cmd-'));
  writeFileSync(join(dir, 'test'), 'pnpm test\n');
  writeFileSync(join(dir, 'check'), '');
  const bin = stubBin({ sudo: 'for a in "$@"; do echo "ARG:$a"; done; echo ENV_KEY=${OPENCODE_API_KEY:-unset}' });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    KINSHO_COMMAND_DIR: dir,
    KINSHO_SANDBOX_USER: 'kinsho-sbx',
    OPENCODE_API_KEY: 'api-key-value'
  };
  const run = spawnSync(process.execPath, [EXEC_SCRIPT, 'test'], { encoding: 'utf8', env });
  assert.match(run.stdout, /ARG:-u\nARG:kinsho-sbx/);
  assert.match(run.stdout, /ARG:pnpm test/);
  assert.match(run.stdout, /\[kinsho-exec test: exit 0\]/);

  // No command configured: nothing runs.
  const none = spawnSync(process.execPath, [EXEC_SCRIPT, 'check'], { encoding: 'utf8', env });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /configured no check command/);

  // Commands not enabled for the run (no sandbox user): nothing runs.
  const off = spawnSync(process.execPath, [EXEC_SCRIPT, 'test'], { encoding: 'utf8', env: { PATH: env.PATH } });
  assert.equal(off.status, 2);
  assert.match(off.stderr, /not enabled/);
});

test('capOutput keeps the head and tail of long output', () => {
  assert.equal(capOutput('short'), 'short');
  const long = `${'a'.repeat(50)}${'b'.repeat(50)}`;
  const capped = capOutput(long, 20);
  assert.ok(capped.startsWith('a'.repeat(10)));
  assert.ok(capped.endsWith('b'.repeat(10)));
  assert.match(capped, /80 characters omitted/);
});

test('findLeak catches exact secrets and GitHub token shapes, and ignores ordinary text', () => {
  assert.equal(findLeak('the key is sk-live-abcdefgh12345', ['sk-live-abcdefgh12345']), 'a secret value');
  assert.equal(findLeak('token ghs_' + 'a'.repeat(36)), 'a GitHub token');
  assert.equal(findLeak('github_pat_' + 'A'.repeat(30)), 'a GitHub token');
  assert.equal(findLeak('Reviewed HEAD: `' + 'a'.repeat(40) + '`', ['', undefined, 'short']), null);
  assert.equal(findLeak('ghs_ is a prefix; see the docs'), null);
});
