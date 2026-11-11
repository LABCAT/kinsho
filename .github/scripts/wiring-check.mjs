// Checks on the files that decide what the review model can reach. They return
// a list of violations; empty means the wiring is as intended. The tests run them
// on the real files and on deliberately broken fixtures.

export const ALLOWED_BASH = [
  'node .kinsho/.github/scripts/kinsho-gh.mjs *',
  'node .kinsho/.github/scripts/kinsho-exec.mjs test',
  'node .kinsho/.github/scripts/kinsho-exec.mjs check'
];
export const ALLOWED_SECRETS = ['OPENCODE_API_KEY', 'LLM_API_KEY', 'KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY'];
export const FORBIDDEN_SECRET = /CLOUDFLARE|NEON|DATABASE|PROD/i;
const TOOL_ALLOWED = ['read', 'grep', 'glob', 'list', 'webfetch', 'bash'];

// Indentation-based reader for the agent file's front matter: nested maps of
// scalar values, which is all the permission block uses.
export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(String(text));
  const root = {};
  if (!match) return root;
  const stack = [{ indent: -1, node: root }];
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const parsed = /^(?:"([^"]*)"|([^:\s][^:]*?)):\s*(.*)$/.exec(line.trim());
    if (!parsed) continue;
    const key = parsed[1] ?? parsed[2];
    const value = parsed[3].replace(/^"(.*)"$/, '$1');
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).node;
    if (value === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key] });
    } else {
      parent[key] = value;
    }
  }
  return root;
}

export function agentViolations(text) {
  const out = [];
  const permission = parseFrontmatter(text).permission;
  if (!permission || typeof permission !== 'object') return ['the agent file has no permission block'];
  if (permission['*'] !== 'deny') out.push('permission "*" must be deny');
  for (const tool of ['edit', 'write', 'patch', 'task', 'external_directory']) {
    if (permission[tool] && permission[tool] !== 'deny') out.push(`${tool} must not be allowed`);
  }
  for (const [tool, rule] of Object.entries(permission)) {
    if (tool === '*' || tool === 'bash') continue;
    if (rule !== 'deny' && !TOOL_ALLOWED.includes(tool)) out.push(`${tool} is allowed but is not an approved tool`);
    if (typeof rule === 'object') out.push(`${tool} must be a plain allow or deny`);
  }
  const bash = permission.bash;
  if (typeof bash !== 'object' || bash === null) {
    out.push('bash must be a pattern map that starts from deny');
  } else {
    if (bash['*'] !== 'deny') out.push('bash "*" must be deny');
    for (const [pattern, rule] of Object.entries(bash)) {
      if (pattern === '*') continue;
      if (rule !== 'allow') continue;
      if (!ALLOWED_BASH.includes(pattern)) out.push(`bash pattern "${pattern}" is not on the allowlist`);
    }
  }
  return out;
}

// Split a workflow into its steps without a YAML parser: the steps of a job
// start at `      - ` (six spaces).
export function workflowSteps(text) {
  const steps = [];
  const parts = String(text).split(/^ {6}- /m).slice(1);
  for (const part of parts) {
    const body = `      - ${part}`;
    const name = /name:\s*(.+)/.exec(body)?.[1]?.trim() ?? '';
    const id = /^\s*(?:- )?id:\s*(\S+)/m.exec(body)?.[1] ?? '';
    steps.push({ name, id, body });
  }
  return steps;
}

export function workflowViolations(text) {
  const out = [];
  const code = String(text).replace(/^\s*#.*$/gm, '');
  if (/secrets:\s*inherit/.test(code)) out.push('secrets: inherit is not allowed');
  if (/pull_request_target/.test(code)) out.push('pull_request_target is not allowed');
  for (const [, name] of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    if (FORBIDDEN_SECRET.test(name)) out.push(`secret ${name} is production-scoped`);
    else if (!ALLOWED_SECRETS.includes(name)) out.push(`secret ${name} is not one of ${ALLOWED_SECRETS.join(', ')}`);
  }
  for (const [, name] of code.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) {
    if (FORBIDDEN_SECRET.test(name)) out.push(`environment variable ${name} is production-scoped`);
  }
  const steps = workflowSteps(code);
  const run = steps.find((step) => step.name === 'Run Kinsho review');
  if (!run) {
    out.push('the model step "Run Kinsho review" is missing');
  } else {
    const token = /^\s+GH_TOKEN:\s*(.+)$/m.exec(run.body)?.[1] ?? '';
    if (!token.includes('steps.read-token.outputs.token')) out.push('the model step GH_TOKEN must be the read-only token');
    if (/app-token/.test(run.body)) out.push('the model step must not see the write token');
    for (const [, name] of run.body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (name !== 'OPENCODE_API_KEY' && name !== 'LLM_API_KEY') out.push(`the model step must not see secret ${name}`);
    }
  }
  const read = steps.find((step) => step.id === 'read-token');
  if (!read) {
    out.push('the read-only token step is missing');
  } else {
    const perms = [...read.body.matchAll(/permission-([a-z-]+):\s*(\S+)/g)];
    if (perms.length === 0) out.push('the read-only token must name its permissions');
    for (const [, name, level] of perms) {
      if (level !== 'read') out.push(`read-only token permission ${name} is ${level}`);
    }
  }
  const write = steps.find((step) => step.id === 'app-token');
  if (write && /read-token/.test(write.body)) out.push('the write token step must be separate from the read token');
  return out;
}
