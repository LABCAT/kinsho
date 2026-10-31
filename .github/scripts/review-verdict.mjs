// Kinsho PR reviewer — verdict taxonomy, label transitions, comment
// composition, and prompt construction.
//
// Plain .mjs with no dependencies so `node --test` and the workflow's node
// steps exercise the same functions.

export const PR_READY_LABEL = 'pr-ready';
export const REVIEW_BLOCKED_LABEL = 'review:blocked';
export const REVIEW_NEEDS_EVIDENCE_LABEL = 'review:needs-evidence';
export const REVIEW_AUTOMATION_FAILED_LABEL = 'review:automation-failed';
export const REVIEW_VERDICT_LABELS = [REVIEW_BLOCKED_LABEL, REVIEW_NEEDS_EVIDENCE_LABEL];
export const ALL_REVIEW_LABELS = [
  PR_READY_LABEL,
  ...REVIEW_VERDICT_LABELS,
  REVIEW_AUTOMATION_FAILED_LABEL
];

// `gh pr edit --add-label` fails on a label the repository does not have, so the
// workflow creates any missing review label before it writes one.
export const REVIEW_LABEL_DEFINITIONS = [
  { name: PR_READY_LABEL, color: '0e8a16', description: 'Kinsho PASS on the current head' },
  { name: REVIEW_BLOCKED_LABEL, color: 'b60205', description: 'Kinsho verdict: BLOCKED' },
  { name: REVIEW_NEEDS_EVIDENCE_LABEL, color: 'fbca04', description: 'Kinsho verdict: NEEDS_EVIDENCE' },
  {
    name: REVIEW_AUTOMATION_FAILED_LABEL,
    color: 'd93f0b',
    description: 'Kinsho review backend failed; not a verdict'
  }
];

// GitHub label names are case-insensitive: an existing `PR-Ready` is `pr-ready`.
export function missingReviewLabels(existing = []) {
  const have = new Set(existing.map((name) => String(name).toLowerCase()));
  return REVIEW_LABEL_DEFINITIONS.filter((label) => !have.has(label.name.toLowerCase()));
}

export function missingSecrets(env = {}) {
  return REQUIRED_SECRETS.filter((name) => !env[name]);
}

// Unambiguous headers: the reviewer and the preview gate post as the same
// Kinsho identity, so the header is what tells them apart at a glance.
export const REVIEWER_HEADER = '## Kinsho review';
export const PREVIEW_GATE_HEADER = '## Kinsho preview gate';
export const PREVIEW_URL_HEADER = '## Kinsho preview';

export const META_MARKER_PREFIX = '<!-- oc-review-meta ';

// Used when a caller's KINSHO_MODEL / KINSHO_EFFORT variable is unset or empty.
// The workflow's input defaults must match; a test pins that.
export const DEFAULT_MODEL = 'opencode-go/gpt-6-luna';
export const DEFAULT_EFFORT = 'high';

export const REQUIRED_SECRETS = ['OPENCODE_API_KEY', 'KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY'];

export const VERDICTS = ['blocked', 'needs-evidence', 'pass'];

const VERDICT_DISPLAY = {
  blocked: 'BLOCKED',
  'needs-evidence': 'NEEDS_EVIDENCE',
  pass: 'PASS'
};

const VERDICT_LABELS = {
  blocked: REVIEW_BLOCKED_LABEL,
  'needs-evidence': REVIEW_NEEDS_EVIDENCE_LABEL,
  pass: PR_READY_LABEL
};

// Transient backend failures worth retrying: overload, rate limit, gateway and
// connection errors. Deliberately does not match a bare "APIError": a 401 from a
// bad credential is an APIError too, and retrying it wastes minutes. Structured
// signals (`isRetryable`, `statusCode`) are preferred; see `classifyRun`.
export const TRANSIENT_ERROR_PATTERN =
  /overloaded|rate[\s_-]?limit|too many requests|timed?\s?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|service unavailable|connection reset|backend is temporarily|server_error/i;

// HTTP statuses worth a retry: rate limit and the 5xx gateway/server family.
export const TRANSIENT_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

export function displayVerdict(verdict) {
  return VERDICT_DISPLAY[normalizeVerdict(verdict)] ?? null;
}

export function normalizeVerdict(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return VERDICTS.includes(value) ? value : null;
}

export function verdictLabel(verdict) {
  const value = normalizeVerdict(verdict);
  return value ? VERDICT_LABELS[value] : null;
}

export function isReviewLabel(label) {
  return ALL_REVIEW_LABELS.includes(label);
}

export function metaMarker({ head, verdict, model = '', effort = '' }) {
  const meta = { head, verdict: normalizeVerdict(verdict) };
  // Only a review a model produced names one; a safety block runs no model.
  if (model) Object.assign(meta, { model, effort });
  return `${META_MARKER_PREFIX}${JSON.stringify(meta)} -->`;
}

// An unset variable reaches the workflow as an empty string, which a `default:`
// does not replace, so empty and blank values fall back here.
export function resolveModelSettings({ model = '', effort = '' } = {}) {
  return {
    model: String(model ?? '').trim() || DEFAULT_MODEL,
    effort: String(effort ?? '').trim() || DEFAULT_EFFORT
  };
}

// Parse `opencode models --verbose`: an id line (`provider/model`) followed by
// that model's JSON metadata. Returns Map<id, string[] | null> of effort variants.
export function parseModelCatalog(text = '') {
  const catalog = new Map();
  let id = null;
  let json = [];
  const finish = () => {
    if (!id) return;
    let variants = null;
    try {
      const parsed = JSON.parse(json.join('\n'));
      if (parsed?.variants && typeof parsed.variants === 'object') {
        variants = Object.keys(parsed.variants);
      }
    } catch {
      // Metadata we cannot read means no known variants; the id still counts.
    }
    catalog.set(id, variants);
  };
  for (const line of String(text).split('\n')) {
    // Metadata lines start with `{`, `}` or indentation; an id starts in column 0.
    if (/^[^\s{}/]+\/\S+$/.test(line)) {
      finish();
      id = line;
      json = [];
    } else if (id) {
      json.push(line);
    }
  }
  finish();
  return catalog;
}

// Check the settings against the catalog the CLI reports. Fails closed: a model
// or effort the backend does not offer is an error, never a silent fallback.
export function checkModelSettings({ model, effort }, catalog) {
  if (!/^[^\s/]+\/\S+$/.test(model)) {
    return { ok: false, reason: `KINSHO_MODEL "${model}" must look like provider/model, for example ${DEFAULT_MODEL}.` };
  }
  if (!(catalog instanceof Map) || catalog.size === 0) {
    return { ok: false, reason: 'Could not list the available models, so "' + model + '" cannot be checked.' };
  }
  if (!catalog.has(model)) {
    const provider = model.split('/')[0];
    const near = [...catalog.keys()].filter((id) => id.startsWith(`${provider}/`)).slice(0, 12);
    return {
      ok: false,
      reason:
        `Model "${model}" is not available.` +
        (near.length ? ` Available ${provider} models include: ${near.join(', ')}.` : ` No "${provider}" provider is available.`)
    };
  }
  const variants = catalog.get(model);
  if (!variants || !variants.includes(effort)) {
    return {
      ok: false,
      reason: variants?.length
        ? `Effort "${effort}" is not supported by ${model}. Supported: ${variants.join(', ')}.`
        : `${model} has no effort levels, so effort "${effort}" cannot be applied. Pick a model that supports effort.`
    };
  }
  return { ok: true, reason: 'ok' };
}

// The machine-readable marker must be the final non-empty line, so a review can
// never be confused with prose that merely mentions a verdict.
export function parseMeta(body) {
  if (typeof body !== 'string') return null;
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last || !last.startsWith(META_MARKER_PREFIX) || !last.endsWith('-->')) return null;
  const json = last.slice(META_MARKER_PREFIX.length, -'-->'.length).trim();
  try {
    const parsed = JSON.parse(json);
    const verdict = normalizeVerdict(parsed?.verdict);
    if (!verdict || typeof parsed?.head !== 'string' || !parsed.head) return null;
    return { head: parsed.head, verdict };
  } catch {
    return null;
  }
}

// The model's raw output carries the verdict line; the workflow adds the header
// and the metadata marker. Reading the verdict from the raw text lets the
// workflow reject a review that never stated one.
export function extractVerdict(body) {
  const match = String(body ?? '').match(/\*\*Verdict:\s*([A-Za-z_-]+)\s*\*\*/);
  return match ? normalizeVerdict(match[1]) : null;
}

// A review only counts when the marker names the pinned head, the human verdict
// line agrees with the marker, and the comment identifies the reviewed head.
export function validateReview({ body, head }) {
  if (typeof body !== 'string' || !body.trim()) {
    return { ok: false, reason: 'empty-review' };
  }
  const meta = parseMeta(body);
  if (!meta) return { ok: false, reason: 'missing-or-malformed-meta' };
  if (meta.head !== head) return { ok: false, reason: `meta-head-mismatch:${meta.head}` };
  if (!body.includes(`**Verdict: ${displayVerdict(meta.verdict)}**`)) {
    return { ok: false, reason: 'verdict-line-mismatch' };
  }
  if (!body.includes(`Reviewed HEAD: \`${head}\``)) {
    return { ok: false, reason: 'head-line-missing' };
  }
  return { ok: true, verdict: meta.verdict, reason: 'ok' };
}

// Compose the single immutable comment: one header, the model's body, the
// reviewed head, an optional implementer routing marker, the run link, and the
// machine-readable verdict as the final line.
export function composeReviewComment({ body, head, verdict, runUrl = '', route = false, routingMarker = '', model = '', effort = '' }) {
  const value = normalizeVerdict(verdict);
  if (!value) throw new Error(`composeReviewComment: unsupported verdict ${verdict}`);

  const lines = String(body ?? '').split('\n');
  const dropEdge = () => {
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines.at(-1).trim() === '') lines.pop();
  };
  dropEdge();
  if (lines[0]?.trim() === REVIEWER_HEADER) lines.shift();
  if (routingMarker && lines.at(-1)?.trim() === routingMarker) lines.pop();
  if (lines.at(-1)?.trim().startsWith(META_MARKER_PREFIX)) lines.pop();
  dropEdge();

  const out = [REVIEWER_HEADER, ''];
  // Guarantee the reviewed head is stated even if the model omitted the line.
  if (!lines.some((line) => line.trim() === `Reviewed HEAD: \`${head}\``)) {
    out.push(`**Verdict: ${displayVerdict(value)}**`, `Reviewed HEAD: \`${head}\``, '');
  }
  out.push(lines.join('\n'));
  if (model) out.push('', `model: ${model} · effort: ${effort}`);
  // The routing marker asks the implementer to pick up fixes, so it only ever
  // appears on a verdict that requests them — never on a PASS.
  if (route && routingMarker && value !== 'pass') out.push('', routingMarker);
  if (runUrl) out.push('', `[Review run](${runUrl})`);
  out.push('', metaMarker({ head, verdict: value, model, effort }));
  return out.join('\n');
}

// A backend failure is never a verdict: it sets no review label and is posted
// with an explicit automation-failure line so it cannot stand as the reviewer.
export function automationFailureComment({ head, runUrl = '', attempts = 0, error = '' }) {
  const firstError = String(error ?? 'unknown error').split('\n')[0].slice(0, 300);
  return [
    REVIEWER_HEADER,
    '',
    '**Verdict: NONE — automation failure**',
    '',
    `The review backend failed after ${attempts} attempt(s). This is not a reviewer verdict: no \`${PR_READY_LABEL}\` signal is set and no verdict label is applied.`,
    'Re-trigger the review with a `/oc` comment once the backend recovers.',
    '',
    `Reviewed HEAD: \`${head}\``,
    `Last error: ${firstError}`,
    runUrl ? `[Review run](${runUrl})` : null
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// Label transitions for a verdict. pr-ready survives only a PASS recorded
// against the current head; the verdict labels are mutually exclusive.
export function labelTransitions({ verdict, currentLabels = [], onHead = false }) {
  const value = normalizeVerdict(verdict);
  // No verdict (automation failure) leaves labels untouched, so a backend error
  // cannot strip a previous PASS.
  if (!value) return { add: [], remove: [] };

  const labels = new Set(currentLabels);
  const desired = value === 'pass' ? (onHead ? PR_READY_LABEL : null) : verdictLabel(value);

  const add = [];
  const remove = [];
  for (const label of REVIEW_VERDICT_LABELS) {
    if (label !== desired && labels.has(label)) remove.push(label);
  }
  if (desired !== PR_READY_LABEL && labels.has(PR_READY_LABEL)) remove.push(PR_READY_LABEL);
  if (desired && !labels.has(desired)) add.push(desired);

  return { add, remove };
}

export function isTransientError(text) {
  return TRANSIENT_ERROR_PATTERN.test(String(text ?? ''));
}

export function backoffDelayMs(attempt, { baseMs = 15000, maxMs = 120000, jitter = 0 } = {}) {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return jitter > 0 ? Math.round(base + Math.random() * jitter) : base;
}

// Parse `opencode run --format json` output: one JSON event per line. Returns the
// parsed events plus the joined text of the final assistant message.
export function parseRunOutput(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON noise on stdout is ignored.
    }
  }

  const texts = events.filter((event) => event?.type === 'text' && event.part?.text);
  const messageID = texts.length > 0 ? texts.at(-1).part.messageID : null;
  const message = texts
    .filter((event) => event.part.messageID === messageID)
    .map((event) => event.part.text)
    .join('\n\n')
    .trim();

  const errors = events.filter((event) => event?.type === 'error').map((event) => event.error ?? event);
  return { events, message, errors };
}

export function extractReviewText(stdout) {
  return parseRunOutput(stdout).message;
}

export function extractErrorText(stdout) {
  return parseRunOutput(stdout)
    .errors.map((error) => JSON.stringify(error))
    .join('\n');
}

// Decide what a run produced. The structured fields win: a non-retryable status
// (a bad credential, a 4xx) is never retried even though it is an `APIError`.
export function classifyRun({ stdout = '', exitCode = 0, message = '' } = {}) {
  const parsed = parseRunOutput(stdout);
  const text = message || parsed.message;
  const verdict = extractVerdict(text);
  if (verdict) return { kind: 'review', verdict, message: text, error: '' };

  const errors = parsed.errors;
  const errorText = errorSummary({ stdout }) || errors.map((error) => JSON.stringify(error)).join('\n');
  const nonRetryable = errors.some((error) => error?.data?.isRetryable === false);
  const statusCode = errors.map((error) => error?.data?.statusCode).find((code) => typeof code === 'number');

  // A timeout is always worth one more attempt.
  if (exitCode === 124) return { kind: 'transient', verdict: null, message: '', error: errorText || 'review timed out' };

  if (!nonRetryable) {
    if (statusCode && TRANSIENT_STATUS_CODES.includes(statusCode)) {
      return { kind: 'transient', verdict: null, message: '', error: errorText };
    }
    if (isTransientError(errorText) || (errors.length === 0 && isTransientError(stdout))) {
      return { kind: 'transient', verdict: null, message: '', error: errorText };
    }
  }

  if (errors.length > 0 || exitCode !== 0) {
    return { kind: 'failed', verdict: null, message: '', error: errorText };
  }
  // Exited cleanly but produced no verdict: an unusable review, not a failure.
  return { kind: 'failed', verdict: null, message: '', error: 'the run ended without a structured verdict' };
}

// A one-line, human-readable reason from the CLI's structured error events.
export function errorSummary({ stdout = '' } = {}) {
  for (const error of parseRunOutput(stdout).errors) {
    const message = error?.data?.message ?? error?.message ?? error?.name;
    if (message) return String(message).split('\n')[0].slice(0, 300);
  }
  return '';
}

// Files that define the reviewer's own policy or trust boundary. Automated
// review cannot clear changes to these: a PR that edits the reviewer could
// weaken it, so the review is BLOCKED and a human must decide.
export const REVIEWER_OWNED_PATHS = [
  /^\.github\/workflows\/opencode-review\.yml$/,
  /^\.github\/scripts\/review-/,
  /^\.opencode\//
];

// The caller's `protected_paths` input: one regex per line. A bad regex throws, so
// the safety step fails visibly instead of quietly protecting less.
export function parseProtectedPaths(text = '') {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((source) => new RegExp(source));
}

export function reviewerOwnedChanges(files = [], extraPaths = []) {
  const patterns = [...REVIEWER_OWNED_PATHS, ...extraPaths];
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

// The BLOCKED review posted when a PR touches reviewer-owned files.
export function safetyBlockedBody({ files = [], head = '', runUrl = '', route = false, routingMarker = '' } = {}) {
  const body = [
    '**Verdict: BLOCKED**',
    '',
    'Automated review cannot clear changes to the reviewer itself. This PR modifies',
    'files that define Kinsho\'s own policy or trust boundary, so a human must review',
    'it directly:',
    '',
    '```',
    ...files,
    '```',
    '',
    'Suggested fix: review the workflow/agent change by hand, confirm it does not',
    'weaken the verdict taxonomy, the label transitions, or the read-only agent',
    'permissions, then re-run the review.',
    `Reviewed HEAD: \`${head}\``
  ].join('\n');
  return composeReviewComment({ body, head, verdict: 'blocked', runUrl, route, routingMarker });
}

export function buildReviewPrompt({
  repo = 'this repository',
  prNumber = '',
  headSha = '',
  baseRef = 'main',
  headRef = '',
  taskRef = '',
  contextDir = '.review-context',
  projectContext = '',
  reviewRules = '',
  testCommand = '',
  checkCommand = ''
} = {}) {
  const rules = String(reviewRules ?? '').trim();
  // The caller numbers its rules from 2; the tests item comes after them.
  const testsItem = 2 + (rules.match(/^\d+\. /gm) ?? []).length;
  const commands = [testCommand, checkCommand].filter(Boolean).map((command) => `\`${command}\``);
  const context = String(projectContext ?? '').trim();

  return [
    `You are Kinsho, the automated pull request reviewer for ${repo}${context ? `: ${context}` : '.'}`,
    'Humans are the only merge authority — never approve,',
    'merge, or push commits yourself, and never change the repository. You have read-only',
    'tools; the workflow posts your review as one immutable comment.',
    '',
    '## State the verdict up front',
    `Begin the comment with the exact header \`${REVIEWER_HEADER}\`. Then put the verdict on`,
    'its own line, using exactly one of:',
    '- `**Verdict: BLOCKED**` — a concrete correctness, security, guidance, or',
    '  contribution-contract problem must be fixed before merge.',
    '- `**Verdict: NEEDS_EVIDENCE**` — no blocker, but a required artifact (a screenshot,',
    '  a recording, a measurement, or a live-run statement) is missing, stale, or',
    '  contradicted by the diff.',
    '- `**Verdict: PASS**` — no blocker and no missing required artifact.',
    '',
    'Prefer BLOCKED whenever you can name a concrete defect. Never return PASS as bare',
    'prose: a PASS must state what you verified.',
    '',
    '## Findings cite file:line and a suggested fix',
    'Every finding names a file path and line (`path/to/file.ext:123`), states the concrete',
    'failure mode and who is affected, and gives a suggested fix. No finding without a',
    'location and a fix. A review with no findings says so explicitly. Keep nits to at most',
    'three, on one line, and only when nothing bigger exists.',
    '',
    '## Checklist against the task DoD and the repository rules',
    `1. The linked task/issue and its definition of done. Read it from \`${contextDir}/linked/\`${taskRef ? ` (task ${taskRef})` : ''}`,
    '   and check each acceptance criterion against the diff.',
    ...(rules ? [rules] : []),
    `${testsItem}. Required tests and failure cases.${commands.length ? ` ${commands.join(' and ')} must stay green.` : ''}`,
    '',
    '## Cite evidence for breakage claims',
    'If you claim something fails — a test, a script, the build, CI — cite the evidence: the',
    'CI log, or the exact command and its output. Do not assert a failure you have not',
    'observed. If you cannot verify a claim, say it is unverified instead of raising it as a',
    'finding.',
    '',
    '## Re-reviews check the delta',
    `Read the prior review comments in \`${contextDir}/\` and treat the PR as a timeline.`,
    'Identify the previously reviewed head and review the delta since that head. For each',
    'prior finding, say whether it is addressed, still present, or no longer applicable, and',
    'only repeat a finding you have re-verified against the current files.',
    '',
    '## Pull request under review',
    `PR: ${prNumber}`,
    `Head: ${headRef} @ ${headSha}`,
    `Base: ${baseRef}`,
    `Context: \`${contextDir}/\` (pr.json, pr.patch, review-comments.json, linked/<n>.json)`,
    '',
    `State the head you reviewed with a line reading exactly: Reviewed HEAD: \`${headSha}\``
  ].join('\n');
}
