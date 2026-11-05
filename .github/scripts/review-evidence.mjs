// Kinsho evidence policy: what counts as proof that a PR works.
//
// Author claims ("verified", "works", "tested locally") are never evidence. Only
// check runs CI recorded on the PR's head SHA are. A runtime change (app code,
// config, auth, dependencies, migrations) needs a check that ran the app; when the
// caller names those checks in `evidence_checks`, this module enforces it: a PASS
// without them green on the head becomes NEEDS_EVIDENCE.
//
// Plain .mjs with no dependencies, like review-verdict.mjs.

// Docs and tests do not change what ships, so they need no runtime evidence.
const EXEMPT_PATHS = [
  /\.(md|mdx|markdown|txt|rst|adoc)$/i,
  /^docs?\//i,
  /(^|\/)(LICENSE|LICENCE|NOTICE|CODEOWNERS)(\.[^/]*)?$/i,
  /(^|\/)(__tests__|__snapshots__|__mocks__|tests?|e2e|fixtures)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb)$/i,
  /(^|\/)test_[^/]*\.py$/i
];

// Evidence from a check the PR itself can redefine is not evidence.
const CI_DEFINITION_PATHS = [/^\.github\/workflows\//, /^\.github\/actions\//];

// A changed line that is only a comment. Deliberately narrow: `//`, `/*`, `*`,
// `*/`, and `#` followed by a space (so `#include`, `#!` and `#region` are code).
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*\/|\*(\s|$)|#(\s|$)|<!--.*-->\s*$)/;

export function parseEvidenceChecks(text = '') {
  return [
    ...new Set(
      String(text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ];
}

export function isExemptPath(path) {
  return EXEMPT_PATHS.some((pattern) => pattern.test(path));
}

// Split a unified diff (`gh pr diff`) into { path, binary, lines } per file, where
// lines are the added and removed lines without their +/- prefix.
export function parseUnifiedDiff(diff = '') {
  const files = [];
  let current = null;
  for (const line of String(diff ?? '').split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2], from: header[1], binary: false, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true;
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    else if (line.startsWith('+') || line.startsWith('-')) current.lines.push(line.slice(1));
  }
  return files;
}

function isCommentOnly(file) {
  if (file.binary || file.from !== file.path) return false;
  const changed = file.lines.filter((line) => line.trim() !== '');
  // No changed lines at all (a mode change, an empty file) is not provably inert.
  return changed.length > 0 && changed.every((line) => COMMENT_LINE.test(line));
}

// Files whose change can alter runtime behaviour. A rename counts under both
// names: moving a runtime file is a runtime change.
export function runtimeChanges(diff = '') {
  const out = [];
  for (const file of parseUnifiedDiff(diff)) {
    const paths = [...new Set([file.from, file.path])];
    if (paths.every(isExemptPath)) continue;
    if (isCommentOnly(file)) continue;
    out.push(file.path);
  }
  return out;
}

// checks.json as the workflow writes it: { head, error, check_runs: [...] }.
// The latest run per name wins, so a re-run replaces the earlier result.
export function latestCheckRuns(checks) {
  const byName = new Map();
  for (const run of checks?.check_runs ?? []) {
    if (!run?.name) continue;
    const prior = byName.get(run.name);
    if (!prior || Number(run.id) > Number(prior.id)) byName.set(run.name, run);
  }
  return byName;
}

export function checkState(run) {
  if (!run) return 'missing';
  if (run.status !== 'completed') return 'pending';
  return run.conclusion ?? 'unknown';
}

// Named checks not yet finished (missing or still running): the workflow waits on these.
export function pendingEvidenceChecks(checks, required = []) {
  const runs = latestCheckRuns(checks);
  return required.filter((name) => ['missing', 'pending'].includes(checkState(runs.get(name))));
}

// The deterministic gate. `ok` means a PASS may stand.
export function evaluateEvidence({ diff = null, checks = null, required = [], head = '' } = {}) {
  if (required.length === 0) return { ok: true, applies: false, reason: 'no evidence_checks configured' };

  // Fail closed: an unreadable diff is treated as a runtime change.
  const runtime = diff === null ? ['(diff unavailable)'] : runtimeChanges(diff);
  if (runtime.length === 0) return { ok: true, applies: false, runtime, reason: 'docs, tests or comments only' };

  const ciEdits = runtime.filter((path) => CI_DEFINITION_PATHS.some((pattern) => pattern.test(path)));
  if (ciEdits.length > 0) {
    return {
      ok: false,
      applies: true,
      runtime,
      missing: required.map((name) => ({ name, state: 'untrusted' })),
      reason: `the PR edits CI definitions (${ciEdits.join(', ')}), so checks on this head cannot vouch for it; a person must review it`
    };
  }

  if (!checks || checks.error) {
    return {
      ok: false,
      applies: true,
      runtime,
      missing: required.map((name) => ({ name, state: 'unreadable' })),
      reason: `check runs could not be read${checks?.error ? `: ${checks.error}` : ''}`
    };
  }
  if (head && checks.head && checks.head !== head) {
    return {
      ok: false,
      applies: true,
      runtime,
      missing: required.map((name) => ({ name, state: 'stale' })),
      reason: `check runs were read for ${checks.head}, not the reviewed head`
    };
  }

  const runs = latestCheckRuns(checks);
  const missing = required
    .map((name) => ({ name, state: checkState(runs.get(name)) }))
    .filter(({ state }) => state !== 'success');
  return missing.length === 0
    ? { ok: true, applies: true, runtime, missing, reason: 'every evidence check passed on the head' }
    : { ok: false, applies: true, runtime, missing, reason: 'required runtime evidence is missing on the head' };
}

// Turn a model PASS that fails the gate into NEEDS_EVIDENCE, saying why. Any
// other verdict, or a passing gate, is returned unchanged.
export function applyEvidenceGate({ verdict, body, gate, head = '' }) {
  if (verdict !== 'pass' || !gate || gate.ok) return { verdict, body, downgraded: false };
  const lines = [
    '',
    '### Evidence gate',
    '',
    `The review model returned PASS, but this PR changes runtime files and ${gate.reason}.`,
    `Author statements are not evidence; only check runs on \`${head}\` count.`,
    '',
    ...(gate.missing ?? []).map(({ name, state }) => `- \`${name}\`: ${state}`),
    '',
    'Suggested fix: get the listed checks green on this head, then re-run the review with `/oc`.'
  ];
  const replaced = String(body ?? '').replace(/\*\*Verdict:\s*PASS\s*\*\*/gi, '**Verdict: NEEDS_EVIDENCE**');
  return { verdict: 'needs-evidence', body: `${replaced.trimEnd()}\n${lines.join('\n')}`, downgraded: true };
}

// The prompt section. Kept here so the rule and its enforcement live together.
export function evidencePromptSection({ headSha = '', contextDir = '.review-context', evidenceChecks = [] } = {}) {
  return [
    '## Evidence comes from CI, never from the author',
    'The PR description, commit messages and comments are claims, not evidence. "Verified",',
    '"works", "tested locally", "redirects to login", a pasted log or a preview URL count for',
    'nothing toward PASS. Never report something as verified because the author says so.',
    `Evidence is \`${contextDir}/checks.json\`: the check runs CI recorded on head \`${headSha}\`.`,
    'Only a run with status `completed` and conclusion `success` counts; pending, skipped,',
    'neutral, cancelled or failed runs do not.',
    '',
    'A runtime change — app code, config, auth or access control, dependencies or lockfiles,',
    'migrations, build or deploy setup — needs runtime evidence: a successful check that ran',
    'the app and exercised the changed surface (a browser, e2e or smoke test against a running',
    'build). Typecheck, lint, unit tests and a build do not prove the app runs. Without that',
    'check the verdict is NEEDS_EVIDENCE, naming the missing check (for example "a browser',
    'smoke test that loads /admin on the preview"). Docs-only, test-only and comment-only',
    'changes are exempt.',
    ...(evidenceChecks.length
      ? [
          '',
          `This repository names its runtime evidence checks: ${evidenceChecks.map((name) => `\`${name}\``).join(', ')}.`,
          'On a runtime change, PASS needs each of them `success` in checks.json. The workflow',
          'enforces this and turns a PASS without them into NEEDS_EVIDENCE.'
        ]
      : []),
    '',
    'A PASS lists the check runs it rests on.'
  ].join('\n');
}
