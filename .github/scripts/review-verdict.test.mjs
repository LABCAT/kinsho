// Focused validation for the Kinsho reviewer logic: verdict taxonomy, metadata
// round-trip, label transitions, immutable comment composition, JSONL
// extraction, and transient-error classification.
//
// Run with: node --test .github/scripts/review-verdict.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ALL_REVIEW_LABELS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  PR_READY_LABEL,
  REVIEW_AUTOMATION_FAILED_LABEL,
  REVIEW_BLOCKED_LABEL,
  REVIEW_LABEL_DEFINITIONS,
  REVIEW_NEEDS_EVIDENCE_LABEL,
  REVIEWER_HEADER,
  automationFailureComment,
  checkModelSettings,
  backoffDelayMs,
  buildReviewPrompt,
  classifyRun,
  composeReviewComment,
  displayVerdict,
  extractErrorText,
  extractReviewText,
  extractVerdict,
  isReviewLabel,
  isTransientError,
  labelTransitions,
  metaMarker,
  missingReviewLabels,
  missingSecrets,
  normalizeVerdict,
  parseMeta,
  parseModelCatalog,
  parseProtectedPaths,
  resolveModelSettings,
  reviewerOwnedChanges,
  safetyBlockedBody,
  validateReview,
  verdictLabel,
  errorSummary
} from './review-verdict.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ROUTING_MARKER = '<!-- route-to-implementer -->';
const WORKFLOW = readFileSync(new URL('../workflows/review.yml', import.meta.url), 'utf8');
const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const AGENT = readFileSync(new URL('../../.opencode/agent/kinsho-review.md', import.meta.url), 'utf8');

function reviewBody(verdict, head = HEAD) {
  return [
    REVIEWER_HEADER,
    '',
    `**Verdict: ${displayVerdict(verdict)}**`,
    '',
    'Verified the diff against the task DoD.',
    `Reviewed HEAD: \`${head}\``,
    '',
    metaMarker({ head, verdict })
  ].join('\n');
}

test('pr-ready is the public signal callers gate on', () => {
  assert.equal(PR_READY_LABEL, 'pr-ready');
});

test('verdict taxonomy normalizes to the three supported verdicts', () => {
  assert.equal(normalizeVerdict('BLOCKED'), 'blocked');
  assert.equal(normalizeVerdict('needs_evidence'), 'needs-evidence');
  assert.equal(normalizeVerdict(' needs-evidence '), 'needs-evidence');
  assert.equal(normalizeVerdict('PASS'), 'pass');
  assert.equal(normalizeVerdict('human-review-required'), null);
  assert.equal(normalizeVerdict(undefined), null);
});

test('verdict display and labels map one-to-one', () => {
  assert.equal(displayVerdict('blocked'), 'BLOCKED');
  assert.equal(displayVerdict('needs-evidence'), 'NEEDS_EVIDENCE');
  assert.equal(displayVerdict('pass'), 'PASS');
  assert.equal(verdictLabel('blocked'), REVIEW_BLOCKED_LABEL);
  assert.equal(verdictLabel('needs-evidence'), REVIEW_NEEDS_EVIDENCE_LABEL);
  assert.equal(verdictLabel('pass'), PR_READY_LABEL);
  assert.ok(isReviewLabel('pr-ready'));
  assert.ok(isReviewLabel('review:blocked'));
  assert.ok(!isReviewLabel('bug'));
});

test('extractVerdict reads the human line the model must state', () => {
  assert.equal(extractVerdict('**Verdict: BLOCKED**\n\nstuff'), 'blocked');
  assert.equal(extractVerdict('**Verdict: NEEDS_EVIDENCE**'), 'needs-evidence');
  assert.equal(extractVerdict('no verdict here'), null);
});

test('metadata round-trips and must be the final line', () => {
  const body = reviewBody('pass');
  assert.deepEqual(parseMeta(body), { head: HEAD, verdict: 'pass' });

  // Prose after the marker invalidates it — no trailing text allowed.
  assert.equal(parseMeta(`${body}\n\nThanks!`), null);
  assert.equal(parseMeta('no marker here'), null);
  assert.equal(parseMeta(`${metaMarker({ head: HEAD, verdict: 'pass' })}\n\n<!-- oc-review-meta {bad json} -->`), null);
});

test('a review only validates against its own head and matching verdict line', () => {
  assert.deepEqual(validateReview({ body: reviewBody('blocked'), head: HEAD }), {
    ok: true,
    verdict: 'blocked',
    reason: 'ok'
  });

  assert.equal(
    validateReview({ body: reviewBody('pass', OTHER_HEAD), head: HEAD }).reason,
    `meta-head-mismatch:${OTHER_HEAD}`
  );

  const mismatched = [
    REVIEWER_HEADER,
    '**Verdict: PASS**',
    `Reviewed HEAD: \`${HEAD}\``,
    metaMarker({ head: HEAD, verdict: 'blocked' })
  ].join('\n');
  assert.equal(validateReview({ body: mismatched, head: HEAD }).reason, 'verdict-line-mismatch');

  assert.equal(validateReview({ body: '', head: HEAD }).reason, 'empty-review');
});

test('composeReviewComment adds one header, one marker, and keeps the body', () => {
  const raw = [
    REVIEWER_HEADER,
    '',
    '**Verdict: BLOCKED**',
    '',
    '1. **blocker: placement violation**',
    '   File: `src/vendor/Button.js:1`',
    '   Problem: generic code vendored instead of imported.',
    '   Suggested fix: import it from the shared library.',
    `Reviewed HEAD: \`${HEAD}\``,
    metaMarker({ head: HEAD, verdict: 'blocked' })
  ].join('\n');

  const composed = composeReviewComment({
    body: raw,
    head: HEAD,
    verdict: 'blocked',
    runUrl: 'https://example.test/runs/1',
    route: true,
    routingMarker: ROUTING_MARKER
  });

  // Exactly one header and exactly one metadata marker, the marker last.
  assert.equal(composed.split(REVIEWER_HEADER).length - 1, 1);
  assert.equal(composed.split('<!-- oc-review-meta ').length - 1, 1);
  assert.ok(composed.trimEnd().endsWith(metaMarker({ head: HEAD, verdict: 'blocked' })));
  assert.ok(composed.includes(ROUTING_MARKER));
  assert.ok(composed.includes('src/vendor/Button.js:1'));
  assert.deepEqual(parseMeta(composed), { head: HEAD, verdict: 'blocked' });
});

test('composeReviewComment guarantees the reviewed head even when the model omits it', () => {
  const composed = composeReviewComment({
    body: '**Verdict: PASS**\n\nVerified the diff against the DoD.',
    head: HEAD,
    verdict: 'pass'
  });

  assert.ok(composed.includes(`Reviewed HEAD: \`${HEAD}\``));
  assert.ok(composed.includes('**Verdict: PASS**'));
  assert.equal(composed.split('<!-- oc-review-meta ').length - 1, 1);
  assert.deepEqual(parseMeta(composed), { head: HEAD, verdict: 'pass' });
});

test('label transitions: a PASS adds pr-ready only against the current head', () => {
  assert.deepEqual(labelTransitions({ verdict: 'pass', currentLabels: [], onHead: true }), {
    add: [PR_READY_LABEL],
    remove: []
  });
  // Off-head PASS never adds pr-ready and clears any stale one.
  assert.deepEqual(labelTransitions({ verdict: 'pass', currentLabels: [PR_READY_LABEL], onHead: false }), {
    add: [],
    remove: [PR_READY_LABEL]
  });
});

test('label transitions: BLOCKED removes pr-ready and clears the other verdict label', () => {
  assert.deepEqual(
    labelTransitions({
      verdict: 'blocked',
      currentLabels: [PR_READY_LABEL, REVIEW_NEEDS_EVIDENCE_LABEL],
      onHead: true
    }),
    { add: [REVIEW_BLOCKED_LABEL], remove: [REVIEW_NEEDS_EVIDENCE_LABEL, PR_READY_LABEL] }
  );
});

test('label transitions: NEEDS_EVIDENCE is its own state and removes pr-ready', () => {
  assert.deepEqual(
    labelTransitions({ verdict: 'needs-evidence', currentLabels: [PR_READY_LABEL], onHead: true }),
    { add: [REVIEW_NEEDS_EVIDENCE_LABEL], remove: [PR_READY_LABEL] }
  );
  // A pass after a needs-evidence verdict clears the verdict label.
  assert.deepEqual(
    labelTransitions({ verdict: 'pass', currentLabels: [REVIEW_NEEDS_EVIDENCE_LABEL], onHead: true }),
    { add: [PR_READY_LABEL], remove: [REVIEW_NEEDS_EVIDENCE_LABEL] }
  );
});

test('label transitions: no verdict (automation failure) leaves labels untouched', () => {
  assert.deepEqual(
    labelTransitions({ verdict: null, currentLabels: [PR_READY_LABEL, REVIEW_BLOCKED_LABEL] }),
    { add: [], remove: [] }
  );
});

test('every label the reviewer writes has a definition the workflow can create', () => {
  assert.deepEqual(
    REVIEW_LABEL_DEFINITIONS.map((label) => label.name).sort(),
    [...ALL_REVIEW_LABELS].sort()
  );
  for (const { color, description } of REVIEW_LABEL_DEFINITIONS) {
    // `gh label create --color` takes six hex digits without `#`; a tab would
    // break the CLI's tab-separated output.
    assert.match(color, /^[0-9a-f]{6}$/);
    assert.ok(description && !description.includes('\t'));
  }
});

test('missing review labels: only absent ones, matched case-insensitively', () => {
  // A fresh repo has none of the review labels: all must be created.
  assert.deepEqual(
    missingReviewLabels([]).map((label) => label.name),
    REVIEW_LABEL_DEFINITIONS.map((label) => label.name)
  );
  // Only pr-ready exists, under another case.
  assert.deepEqual(
    missingReviewLabels(['bug', 'PR-Ready', 'wontfix']).map((label) => label.name),
    [REVIEW_BLOCKED_LABEL, REVIEW_NEEDS_EVIDENCE_LABEL, REVIEW_AUTOMATION_FAILED_LABEL]
  );
  // Idempotent: once they all exist, nothing is created again.
  assert.deepEqual(missingReviewLabels([...ALL_REVIEW_LABELS, 'bug']), []);
});

test('a backend failure is not a verdict and sets no review label', () => {
  const comment = automationFailureComment({
    head: HEAD,
    runUrl: 'https://example.test/runs/2',
    attempts: 4,
    error: 'APIError: The backend is temporarily overloaded. Please retry.\nstack...'
  });

  assert.ok(comment.startsWith(REVIEWER_HEADER));
  assert.ok(comment.includes('Verdict: NONE'));
  assert.ok(comment.includes('after 4 attempt(s)'));
  assert.ok(comment.includes('APIError: The backend is temporarily overloaded'));
  assert.ok(!comment.includes('stack...'));
  // No structured verdict marker means the label step can never read a pass.
  assert.equal(parseMeta(comment), null);
  assert.equal(extractVerdict(comment), null);
});

test('transient backend failures are retryable, real reviews are not', () => {
  assert.ok(isTransientError('The backend is temporarily overloaded. Please retry.'));
  assert.ok(isTransientError('429 Too Many Requests'));
  assert.ok(isTransientError('request timed out after 30m'));
  assert.ok(isTransientError('ECONNRESET'));
  assert.ok(!isTransientError('**Verdict: BLOCKED**'));
  // A bare APIError is not transient: a 401 from a bad credential is one too.
  assert.ok(!isTransientError('APIError: Invalid credential'));
});

test('classifyRun: a verdict is a review', () => {
  const stdout = [
    JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'draft' } }),
    JSON.stringify({ type: 'text', part: { messageID: 'm2', text: '**Verdict: PASS**' } })
  ].join('\n');

  const result = classifyRun({ stdout, exitCode: 0 });
  assert.equal(result.kind, 'review');
  assert.equal(result.verdict, 'pass');
  assert.equal(result.message, '**Verdict: PASS**');
});

test('classifyRun: an overloaded backend is retryable', () => {
  const stdout = JSON.stringify({
    type: 'error',
    error: { name: 'APIError', data: { message: 'The backend is temporarily overloaded.', isRetryable: true } }
  });

  assert.equal(classifyRun({ stdout, exitCode: 1 }).kind, 'transient');
});

test('classifyRun: a rate-limit status is retryable', () => {
  const stdout = JSON.stringify({
    type: 'error',
    error: { name: 'APIError', data: { message: 'Too many requests', statusCode: 429 } }
  });

  assert.equal(classifyRun({ stdout, exitCode: 1 }).kind, 'transient');
});

test('classifyRun: a bad credential is a hard failure, never retried', () => {
  // Real shape from a 401: an APIError with isRetryable:false and statusCode 401.
  const stdout = JSON.stringify({
    type: 'error',
    timestamp: 1792388578443,
    sessionID: 'ses_x',
    error: {
      name: 'APIError',
      data: {
        message: 'Upstream request failed: Invalid credential',
        statusCode: 401,
        isRetryable: false
      }
    }
  });

  const result = classifyRun({ stdout, exitCode: 1 });
  assert.equal(result.kind, 'failed');
  assert.equal(result.verdict, null);
});

test('classifyRun: a clean exit with no verdict is a hard failure', () => {
  const stdout = JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'I could not review this.' } });
  assert.equal(classifyRun({ stdout, exitCode: 0 }).kind, 'failed');
  assert.equal(classifyRun({ stdout: '', exitCode: 0 }).kind, 'failed');
});

test('backoff grows exponentially and is capped', () => {
  assert.equal(backoffDelayMs(1, { baseMs: 1000, maxMs: 8000 }), 1000);
  assert.equal(backoffDelayMs(2, { baseMs: 1000, maxMs: 8000 }), 2000);
  assert.equal(backoffDelayMs(3, { baseMs: 1000, maxMs: 8000 }), 4000);
  assert.equal(backoffDelayMs(9, { baseMs: 1000, maxMs: 8000 }), 8000);
});

test('reviewer-owned changes are detected and blocked', () => {
  assert.deepEqual(reviewerOwnedChanges(['src/app.js']), []);
  assert.deepEqual(
    reviewerOwnedChanges([
      'src/app.js',
      '.github/workflows/opencode-review.yml',
      '.opencode/agent/kinsho-review.md'
    ]),
    ['.github/workflows/opencode-review.yml', '.opencode/agent/kinsho-review.md']
  );
  // A caller extends the same trust boundary with its own paths.
  const extra = parseProtectedPaths('^deploy/gate\\.mjs$\n\n  ^infra/  \n');
  assert.deepEqual(reviewerOwnedChanges(['deploy/gate.mjs', 'infra/a', 'src/app.js'], extra), ['deploy/gate.mjs', 'infra/a']);
  assert.deepEqual(reviewerOwnedChanges(['deploy/gate.mjs']), []);
  assert.deepEqual(parseProtectedPaths(''), []);
  assert.deepEqual(parseProtectedPaths(undefined), []);
  assert.throws(() => parseProtectedPaths('('));

  const body = safetyBlockedBody({
    files: ['.github/workflows/opencode-review.yml'],
    head: HEAD,
    route: true,
    routingMarker: ROUTING_MARKER
  });
  assert.match(body, /Verdict: BLOCKED/);
  assert.match(body, /Reviewed HEAD: `a{40}`/);
  // Routed PRs keep the routing marker so the implementer picks it up.
  assert.ok(body.includes(ROUTING_MARKER));
});

test('the failure comment is never a verdict and sets no review label', () => {
  const body = automationFailureComment({ head: HEAD, attempts: 3, error: 'Upstream request failed: overloaded' });
  assert.match(body, /Verdict: NONE — automation failure/);
  assert.match(body, /not a reviewer verdict/);
  assert.match(body, /`\/oc` comment/);
  assert.doesNotMatch(body, /\*\*Verdict: (BLOCKED|NEEDS_EVIDENCE|PASS)\*\*/);
  assert.equal(extractVerdict(body), null);
  // A backend error must not carry a verdict label.
  assert.deepEqual(labelTransitions({ verdict: null, currentLabels: [PR_READY_LABEL], onHead: true }), {
    add: [],
    remove: []
  });
});

test('two consecutive runs produce two distinct comments', () => {
  const first = composeReviewComment({ body: '**Verdict: BLOCKED**\n\n1. `a.mjs:1` fix it', head: HEAD, verdict: 'blocked' });
  const second = composeReviewComment({
    body: '**Verdict: PASS**\n\nClean.',
    head: OTHER_HEAD,
    verdict: 'pass'
  });

  // Distinct bodies with distinct metadata: each is posted as a new comment.
  assert.notEqual(first, second);
  assert.equal(parseMeta(first).head, HEAD);
  assert.equal(parseMeta(second).head, OTHER_HEAD);
  assert.equal(parseMeta(first).verdict, 'blocked');
  assert.equal(parseMeta(second).verdict, 'pass');

  // And the label transitions move correctly across the two runs.
  const afterFirst = labelTransitions({ verdict: 'blocked', currentLabels: [], onHead: true });
  assert.deepEqual(afterFirst, { add: [REVIEW_BLOCKED_LABEL], remove: [] });
  const afterSecond = labelTransitions({
    verdict: 'pass',
    currentLabels: [...afterFirst.add],
    onHead: true
  });
  assert.deepEqual(afterSecond, { add: [PR_READY_LABEL], remove: [REVIEW_BLOCKED_LABEL] });
});

test('errorSummary renders a single clean line from a real error event', () => {
  const stdout = JSON.stringify({
    type: 'error',
    error: { name: 'APIError', data: { message: 'Upstream request failed: Invalid credential', statusCode: 401 } }
  });
  assert.equal(errorSummary({ stdout }), 'Upstream request failed: Invalid credential');
  assert.equal(errorSummary({ stdout: 'not json' }), '');
});

test('only a fix-requesting verdict carries the implementer routing marker', () => {
  const blocked = composeReviewComment({
    body: '**Verdict: BLOCKED**\n\n1. `a.mjs:1` fix it',
    head: HEAD,
    verdict: 'blocked',
    route: true,
    routingMarker: ROUTING_MARKER
  });
  const pass = composeReviewComment({
    body: '**Verdict: PASS**\n\nClean.',
    head: HEAD,
    verdict: 'pass',
    route: true,
    routingMarker: ROUTING_MARKER
  });

  assert.ok(blocked.includes(ROUTING_MARKER));
  assert.ok(!pass.includes(ROUTING_MARKER));

  // No marker configured means routing is off, whatever the route flag says.
  const off = composeReviewComment({ body: '**Verdict: BLOCKED**\n\n1. `a.mjs:1` fix', head: HEAD, verdict: 'blocked', route: true });
  assert.ok(!off.includes('undefined'));
  assert.equal(off.split('<!--').length - 1, 1);
});

test('extractReviewText joins only the final assistant message text parts', () => {
  const stdout = [
    JSON.stringify({ type: 'step_start', part: { messageID: 'm1' } }),
    JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'thinking out loud' } }),
    JSON.stringify({ type: 'step_finish', part: { messageID: 'm1' } }),
    'not json noise',
    JSON.stringify({ type: 'text', part: { messageID: 'm2', text: '**Verdict: PASS**' } }),
    JSON.stringify({ type: 'text', part: { messageID: 'm2', text: `Reviewed HEAD: \`${HEAD}\`` } })
  ].join('\n');

  assert.equal(extractReviewText(stdout), `**Verdict: PASS**\n\nReviewed HEAD: \`${HEAD}\``);
  assert.equal(extractReviewText('no events'), '');
});

test('extractErrorText surfaces structured error events', () => {
  const stdout = [
    JSON.stringify({ type: 'text', part: { messageID: 'm1', text: 'hi' } }),
    JSON.stringify({ type: 'error', error: { message: 'APIError: overloaded' } })
  ].join('\n');

  assert.ok(extractErrorText(stdout).includes('overloaded'));
  assert.equal(extractErrorText('nothing'), '');
});

test('the prompt carries the verdict taxonomy, caller rules, and delta re-review', () => {
  const prompt = buildReviewPrompt({
    repo: 'acme/widgets',
    prNumber: '17',
    headSha: HEAD,
    headRef: 'feature/fix',
    taskRef: '#17',
    projectContext: 'a widget factory.',
    reviewRules: '2. Placement: generic code belongs upstream; never accept a fork.\n3. Pin dependencies.',
    testCommand: 'npm test',
    checkCommand: 'npm run lint'
  });

  assert.ok(prompt.includes('**Verdict: BLOCKED**'));
  assert.ok(prompt.includes('**Verdict: NEEDS_EVIDENCE**'));
  assert.ok(prompt.includes('**Verdict: PASS**'));
  assert.ok(prompt.includes(REVIEWER_HEADER));
  // Caller context and rules are carried verbatim, numbered around the fixed items.
  assert.ok(prompt.includes('reviewer for acme/widgets: a widget factory.'));
  assert.ok(prompt.includes('2. Placement: generic code belongs upstream; never accept a fork.\n3. Pin dependencies.'));
  assert.ok(prompt.includes('4. Required tests and failure cases. `npm test` and `npm run lint` must stay green.'));
  // Evidence requirement for breakage claims.
  assert.ok(prompt.includes('cite the evidence'));
  // Delta re-review, and the instruction to ignore earlier comments is gone.
  assert.ok(prompt.includes('review the delta since that head'));
  assert.ok(prompt.includes('Previous reviewed HEAD') || prompt.includes('previously reviewed head'));
  assert.ok(!prompt.includes('Ignore any earlier'));
  assert.ok(prompt.includes(`Reviewed HEAD: \`${HEAD}\``));
});

test('the prompt stands alone with no caller inputs and hardcodes no project', () => {
  const prompt = buildReviewPrompt({ prNumber: '1', headSha: HEAD });
  assert.ok(prompt.includes('reviewer for this repository.'));
  assert.ok(prompt.includes('\n2. Required tests and failure cases.\n'));
  assert.ok(!prompt.includes('must stay green'));
  assert.ok(!prompt.includes('undefined'));
});

test('missingSecrets treats an empty value as unset', () => {
  assert.deepEqual(missingSecrets({ OPENCODE_API_KEY: 'k', KINSHO_APP_ID: '', KINSHO_APP_PRIVATE_KEY: 'p' }), ['KINSHO_APP_ID']);
  assert.equal(missingSecrets({}).length, 3);
});

test('the reusable workflow checks every secret before it uses one', () => {
  assert.match(WORKFLOW, /^ {2}workflow_call:$/m);
  for (const name of ['OPENCODE_API_KEY', 'KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY']) {
    assert.match(WORKFLOW, new RegExp(`^ {6}${name}:$`, 'm'), name);
  }
  const check = WORKFLOW.indexOf('review-cli.mjs requireSecrets');
  assert.ok(check > 0);
  assert.ok(check < WORKFLOW.indexOf('Generate Kinsho app token'));
  assert.ok(check < WORKFLOW.indexOf('Run Kinsho review'));
});

test('the reusable workflow runs its own pinned code, never the caller checkout', () => {
  assert.ok(WORKFLOW.includes('repository: ${{ job.workflow_repository }}'));
  assert.ok(WORKFLOW.includes('ref: ${{ job.workflow_sha }}'));
  // Every script call goes through the Kinsho checkout.
  assert.ok(!/node \.github\/scripts\//.test(WORKFLOW));
  assert.ok(WORKFLOW.indexOf('Resolve Kinsho version') < WORKFLOW.indexOf('Checkout Kinsho'));
});

const CATALOG = parseModelCatalog(
  [
    'opencode-go/gpt-6-luna',
    JSON.stringify({ id: 'gpt-6-luna', variants: { low: {}, high: {}, max: {} } }, null, 2),
    'opencode-go/plain-model',
    JSON.stringify({ id: 'plain-model' }, null, 2),
    'other/model-x',
    JSON.stringify({ id: 'model-x', variants: { high: {} } }, null, 2)
  ].join('\n')
);

test('unset, empty and blank settings take the defaults; set ones win, trimmed', () => {
  const defaults = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  assert.deepEqual(resolveModelSettings(), defaults);
  assert.deepEqual(resolveModelSettings({ model: undefined, effort: undefined }), defaults);
  assert.deepEqual(resolveModelSettings({ model: '', effort: '' }), defaults);
  assert.deepEqual(resolveModelSettings({ model: '  ', effort: '\n' }), defaults);
  assert.deepEqual(resolveModelSettings({ model: ' other/model-x ', effort: ' max ' }), {
    model: 'other/model-x',
    effort: 'max'
  });
  // One set, one unset: each falls back on its own.
  assert.deepEqual(resolveModelSettings({ model: 'other/model-x' }), { model: 'other/model-x', effort: DEFAULT_EFFORT });
});

test('the defaults are gpt-6-luna at high effort', () => {
  assert.equal(DEFAULT_MODEL, 'opencode-go/gpt-6-luna');
  assert.equal(DEFAULT_EFFORT, 'high');
});

test('parseModelCatalog reads ids and their effort variants', () => {
  assert.deepEqual(CATALOG.get('opencode-go/gpt-6-luna'), ['low', 'high', 'max']);
  assert.equal(CATALOG.get('opencode-go/plain-model'), null);
  assert.equal(CATALOG.size, 3);
  assert.equal(parseModelCatalog('').size, 0);
});

test('checkModelSettings accepts an offered model and effort', () => {
  assert.equal(checkModelSettings({ model: DEFAULT_MODEL, effort: DEFAULT_EFFORT }, CATALOG).ok, true);
});

test('checkModelSettings fails closed on a bad model or effort', () => {
  const unknown = checkModelSettings({ model: 'opencode-go/nope', effort: 'high' }, CATALOG);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /"opencode-go\/nope" is not available/);
  assert.match(unknown.reason, /opencode-go\/gpt-6-luna/);

  const noProvider = checkModelSettings({ model: 'missing/model', effort: 'high' }, CATALOG);
  assert.equal(noProvider.ok, false);
  assert.match(noProvider.reason, /No "missing" provider/);

  for (const model of ['gpt-6-luna', 'a b/c', 'opencode-go/', '/x']) {
    const result = checkModelSettings({ model, effort: 'high' }, CATALOG);
    assert.equal(result.ok, false, model);
    assert.match(result.reason, /provider\/model/);
  }

  const effort = checkModelSettings({ model: DEFAULT_MODEL, effort: 'turbo' }, CATALOG);
  assert.equal(effort.ok, false);
  assert.match(effort.reason, /"turbo" is not supported.*low, high, max/);

  const noVariants = checkModelSettings({ model: 'opencode-go/plain-model', effort: 'high' }, CATALOG);
  assert.equal(noVariants.ok, false);
  assert.match(noVariants.reason, /no effort levels/);

  // An empty model list is an outage, not permission to proceed unchecked.
  assert.equal(checkModelSettings({ model: DEFAULT_MODEL, effort: 'high' }, new Map()).ok, false);
  assert.equal(checkModelSettings({ model: DEFAULT_MODEL, effort: 'high' }, null).ok, false);
});

test('a review names the model and effort in the line and the meta marker', () => {
  const body = composeReviewComment({
    body: '**Verdict: PASS**\nReviewed HEAD: `' + HEAD + '`\nok',
    head: HEAD,
    verdict: 'pass',
    model: 'opencode-go/gpt-6-luna',
    effort: 'high'
  });
  assert.ok(body.includes('model: opencode-go/gpt-6-luna · effort: high'));
  assert.match(body.split('\n').at(-1), /"model":"opencode-go\/gpt-6-luna","effort":"high"/);
  // The marker still parses and validates as before.
  assert.deepEqual(parseMeta(body), { head: HEAD, verdict: 'pass' });
  assert.equal(validateReview({ body, head: HEAD }).ok, true);
});

test('a comment with no model (a safety block) claims none', () => {
  const body = safetyBlockedBody({ files: ['.github/workflows/opencode-review.yml'], head: HEAD });
  assert.ok(!body.includes('model:'));
  assert.ok(!body.includes('"model"'));
});

test('the workflow declares model and effort inputs with the stated defaults', () => {
  const input = (name) =>
    WORKFLOW.match(new RegExp(`^ {6}${name}:\\n(?: {8}.+\\n)*? {8}default: (.+)$`, 'm'))[1];
  assert.equal(input('model'), DEFAULT_MODEL);
  assert.equal(input('effort'), DEFAULT_EFFORT);
});

test('the agent file pins no model, so the workflow input is the only source', () => {
  assert.ok(!/^model:/m.test(AGENT));
  assert.match(WORKFLOW, /-m "\$KINSHO_MODEL" --variant "\$KINSHO_EFFORT"/);
});

test('the model is checked before the review runs and before anything is posted', () => {
  const resolve = WORKFLOW.indexOf('review-cli.mjs resolveModel');
  assert.ok(resolve > 0);
  assert.ok(resolve < WORKFLOW.indexOf('Run Kinsho review'));
  assert.ok(resolve < WORKFLOW.indexOf('Post review comment'));
  // The run and the comment use the checked values, never the raw inputs.
  assert.ok(WORKFLOW.includes('KINSHO_MODEL: ${{ steps.model.outputs.model }}'));
  assert.ok(WORKFLOW.includes('REVIEW_MODEL: ${{ steps.model.outputs.model }}'));
  assert.ok(!WORKFLOW.includes('KINSHO_MODEL: ${{ inputs.model }}'));
});

test('the requested model and effort are logged before the secrets check can fail', () => {
  const log = WORKFLOW.indexOf('Log requested model and effort');
  assert.ok(log > 0);
  assert.ok(log < WORKFLOW.indexOf('review-cli.mjs requireSecrets'));
});

test('the README caller snippet passes both repository variables', () => {
  assert.ok(README.includes('model: ${{ vars.KINSHO_MODEL }}'));
  assert.ok(README.includes('effort: ${{ vars.KINSHO_EFFORT }}'));
});
