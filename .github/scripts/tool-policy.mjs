// What the review model may run. Pure functions with no dependencies, shared by
// the two wrapper scripts, the guard plugin and the tests.
//
// The model never gets a shell. It may run exactly two scripts through `bash`:
//   kinsho-gh.mjs    read-only GitHub CLI calls, validated here argument by argument
//   kinsho-exec.mjs  the caller's test/check command, in a sandbox with no secrets
// and fetch documentation over `webfetch`. Everything else is denied twice: by
// the agent file's permission list and by `checkBashCommand` / `checkWebfetchUrl`.

export const SCRIPTS_DIR = '.kinsho/.github/scripts';

// `webfetch` takes no domain list in opencode's permission config, so the guard
// plugin enforces this one. `path` limits a host to part of its site.
export const DOCS_HOSTS = [
  { host: 'docs.github.com', path: '/' },
  { host: 'developers.cloudflare.com', path: '/' },
  { host: 'neon.tech', path: '/docs' },
  { host: 'orm.drizzle.team', path: '/' },
  { host: 'svelte.dev', path: '/' },
  { host: 'opencode.ai', path: '/docs' }
];

export function checkWebfetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https URLs may be fetched' };
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (url.port) return { ok: false, reason: 'URLs with a port are not allowed' };
  const rule = DOCS_HOSTS.find(({ host }) => url.hostname === host);
  if (!rule) return { ok: false, reason: `${url.hostname} is not an allowed documentation host` };
  const inside = rule.path === '/' || url.pathname === rule.path || url.pathname.startsWith(`${rule.path}/`);
  if (!inside) return { ok: false, reason: `only ${rule.host}${rule.path} may be fetched` };
  return { ok: true, reason: 'ok' };
}

// A bash command passes only if it is one of the two scripts followed by words
// made of characters the shell treats literally, or single-quoted strings. No
// `;`, `&`, `|`, `$`, backtick, `<`, `>`, `(`, `{`, `~`, glob or newline can appear
// outside quotes, so there is no chaining, substitution or redirection to
// reason about. Anything else is rejected, never repaired.
const WORD = "(?:[A-Za-z0-9_.\\/:@=,+%-]+|'[^'\\n]*')";
const BASH_ALLOWED = new RegExp(`^node ${SCRIPTS_DIR.replaceAll('.', '\\.')}/(kinsho-gh|kinsho-exec)\\.mjs((?: +${WORD})*)$`);

export function checkBashCommand(command) {
  if (typeof command !== 'string' || !command) return { ok: false, reason: 'empty command' };
  const match = BASH_ALLOWED.exec(command);
  if (!match) {
    return {
      ok: false,
      reason: `only \`node ${SCRIPTS_DIR}/kinsho-gh.mjs ...\` and \`node ${SCRIPTS_DIR}/kinsho-exec.mjs test|check\` may run, with plain or single-quoted arguments`
    };
  }
  return { ok: true, script: match[1], reason: 'ok' };
}

// Split an allowed command's argument text into its words (quotes removed).
export function splitWords(text) {
  const words = [];
  for (const m of String(text).matchAll(new RegExp(WORD, 'g'))) {
    words.push(m[0].startsWith("'") ? m[0].slice(1, -1) : m[0]);
  }
  return words;
}

const DIGITS = /^\d+$/;
const JSON_FIELDS = /^[A-Za-z][A-Za-z,]*$/;
const ACCEPT_HEADER = /^Accept: ?[A-Za-z0-9./+;=-]+$/i;

// Flags per subcommand: true takes no value; a function validates the value.
const GH_COMMANDS = {
  api: {
    flags: {
      '--paginate': true,
      '--slurp': true,
      '--jq': () => true,
      '-q': () => true,
      '--method': (v) => v.toUpperCase() === 'GET',
      '-X': (v) => v.toUpperCase() === 'GET',
      '--header': (v) => ACCEPT_HEADER.test(v),
      '-H': (v) => ACCEPT_HEADER.test(v)
    },
    // Reads of this repository's REST API. `graphql` is a POST and anything
    // outside `repos/` is not what a review needs.
    positional: (v) => /^\/?repos\//.test(v) && !v.split(/[?#]/)[0].split('/').includes('..')
  },
  'pr view': {
    flags: { '--json': (v) => JSON_FIELDS.test(v), '--jq': () => true, '-q': () => true, '--comments': true },
    positional: (v) => DIGITS.test(v)
  },
  'pr diff': { flags: { '--name-only': true, '--patch': true }, positional: (v) => DIGITS.test(v) },
  'pr checks': {
    flags: { '--json': (v) => JSON_FIELDS.test(v), '--jq': () => true, '-q': () => true },
    positional: (v) => DIGITS.test(v)
  },
  'run view': {
    flags: {
      '--log': true,
      '--log-failed': true,
      '--json': (v) => JSON_FIELDS.test(v),
      '--jq': () => true,
      '-q': () => true,
      '--job': (v) => DIGITS.test(v),
      '--attempt': (v) => DIGITS.test(v)
    },
    positional: (v) => DIGITS.test(v)
  }
};

// Validate the arguments after `gh`. Allowlist only: an unknown flag, a second
// positional, a non-GET method or a write flag is rejected, so `-f`, `-F`,
// `--field`, `--raw-field`, `--input`, `--hostname` and header tricks never reach `gh`.
export function validateGhArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: 'no gh command given' };
  const two = `${argv[0]} ${argv[1] ?? ''}`;
  const key = argv[0] === 'api' ? 'api' : two;
  const spec = GH_COMMANDS[key];
  if (!spec) {
    return { ok: false, reason: 'allowed: gh api (GET), gh pr view|diff|checks <number>, gh run view <id>' };
  }
  const rest = argv.slice(key === 'api' ? 1 : 2);
  const args = [];
  let positional = null;
  for (let i = 0; i < rest.length; i += 1) {
    let token = rest[i];
    let inline = null;
    if (token.startsWith('--') && token.includes('=')) {
      inline = token.slice(token.indexOf('=') + 1);
      token = token.slice(0, token.indexOf('='));
    }
    if (token.startsWith('-')) {
      if (!Object.hasOwn(spec.flags, token)) return { ok: false, reason: `flag ${token} is not allowed` };
      const rule = spec.flags[token];
      if (rule === true) {
        if (inline !== null) return { ok: false, reason: `flag ${token} takes no value` };
        args.push(token);
        continue;
      }
      const value = inline ?? rest[++i];
      if (value === undefined) return { ok: false, reason: `flag ${token} needs a value` };
      if (!rule(value)) return { ok: false, reason: `value for ${token} is not allowed` };
      args.push(token, value);
      continue;
    }
    if (positional !== null) return { ok: false, reason: 'only one endpoint or number is allowed' };
    if (!spec.positional(token)) return { ok: false, reason: `"${token}" is not an allowed target` };
    positional = token;
    args.push(token);
  }
  if (positional === null) return { ok: false, reason: 'missing endpoint or number' };
  return { ok: true, args: key === 'api' ? ['api', ...args] : [...argv.slice(0, 2), ...args], reason: 'ok' };
}

export const COMMAND_NAMES = ['test', 'check'];

// Keep what a model reads (and might quote) bounded: head and tail of long output.
export function capOutput(text, limit = 60000) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  const half = Math.floor(limit / 2);
  return `${value.slice(0, half)}\n[... ${value.length - limit} characters omitted ...]\n${value.slice(-half)}`;
}

// A review must never carry a credential. `secrets` are exact values to look
// for; the pattern catches GitHub token shapes whatever their source.
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;

export function findLeak(text, secrets = []) {
  const body = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && body.includes(secret)) return 'a secret value';
  }
  return TOKEN_SHAPE.test(body) ? 'a GitHub token' : null;
}

// The argv that runs a caller command as the sandbox user: another uid (so it
// cannot read this process's environment), `env -i` (nothing inherited), a
// timeout, and the command passed as an argument rather than spliced into a
// shell string.
export function sandboxArgv({ command, user, path, seconds = 600 }) {
  return [
    'sudo', '-n', '-u', user, '--',
    'env', '-i', `HOME=/home/${user}`, `PATH=${path}`, 'CI=true', 'LANG=C.UTF-8',
    'timeout', '--signal=TERM', '--kill-after=15s', `${seconds}s`,
    'bash', '-c', 'cd "$HOME/pr" || exit 97; exec bash -c "$1"', 'kinsho', command
  ];
}
