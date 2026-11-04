// Read-only GitHub CLI for the review model. The agent may run only this
// script, never `gh` itself; every argument is checked by `validateGhArgs`
// before `gh` starts, and `gh` gets a bare environment: the read token, the
// repository, and nothing else.
//
//   node .kinsho/.github/scripts/kinsho-gh.mjs api repos/{owner}/{repo}/environments
//   node .kinsho/.github/scripts/kinsho-gh.mjs pr view 12 --json files
//   node .kinsho/.github/scripts/kinsho-gh.mjs run view 123456 --log-failed
import { spawnSync } from 'node:child_process';

import { capOutput, validateGhArgs } from './tool-policy.mjs';

const check = validateGhArgs(process.argv.slice(2));
if (!check.ok) {
  console.error(`kinsho-gh: denied: ${check.reason}`);
  process.exit(2);
}
if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) {
  console.error('kinsho-gh: GH_TOKEN and GITHUB_REPOSITORY must be set.');
  process.exit(2);
}

const result = spawnSync('gh', check.args, {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_TOKEN: process.env.GH_TOKEN,
    GH_REPO: process.env.GITHUB_REPOSITORY,
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1'
  },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120000
});
process.stdout.write(capOutput(result.stdout));
process.stderr.write(capOutput(result.stderr));
process.exit(result.status ?? 1);
