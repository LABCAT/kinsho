// Runs the caller's test or check command for the review model, in a clean
// checkout of the PR head, as an unprivileged user with an empty environment.
// The command text comes from a file the workflow wrote before the model started;
// the model chooses only `test` or `check`, never the command.
//
//   node .kinsho/.github/scripts/kinsho-exec.mjs test
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { COMMAND_NAMES, capOutput, sandboxArgv } from './tool-policy.mjs';

const name = process.argv[2];
if (process.argv.length !== 3 || !COMMAND_NAMES.includes(name)) {
  console.error(`kinsho-exec: denied: usage is ${COMMAND_NAMES.join('|')}`);
  process.exit(2);
}

const { KINSHO_COMMAND_DIR: dir, KINSHO_SANDBOX_USER: user } = process.env;
if (!dir || !user) {
  console.error('kinsho-exec: commands are not enabled for this run.');
  process.exit(2);
}

let command = '';
try {
  command = readFileSync(`${dir}/${name}`, 'utf8').trim();
} catch {
  // Falls through to the "not configured" message.
}
if (!command) {
  console.error(`kinsho-exec: the caller configured no ${name} command.`);
  process.exit(2);
}

const [bin, ...args] = sandboxArgv({ command, user, path: process.env.PATH });
const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(capOutput(result.stdout));
process.stderr.write(capOutput(result.stderr));
console.log(`\n[kinsho-exec ${name}: exit ${result.status ?? 'signal ' + result.signal}]`);
process.exit(result.status ?? 1);
