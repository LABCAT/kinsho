// Workflow-facing CLI for the Kinsho reviewer. Each subcommand reads its inputs
// from the environment and writes files/outputs, so the workflow stays thin and
// the decisions come from the validated `review-verdict.mjs` functions.
//
//   prompt    — write the review prompt for `opencode run`
//   classify  — inspect raw CLI output: is it a review, a transient failure, or neither?
//   backoff   — print the retry delay for an attempt number
//   comment   — turn the model's raw output into the single immutable comment
//   failure   — render the automation-failure comment (never a raw API error)
//   labels    — compute the label transitions for a verdict
//   missingLabels — list the review labels the repository lacks (name\tcolor\tdescription)
//   requireSecrets — fail, naming them, when required secrets are unset
//   resolveModel — settle KINSHO_MODEL / KINSHO_EFFORT (defaults) and check them against the CLI's model list
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import {
  automationFailureComment,
  backoffDelayMs,
  buildReviewPrompt,
  classifyRun,
  composeReviewComment,
  errorSummary,
  extractVerdict,
  labelTransitions,
  missingReviewLabels,
  missingSecrets,
  reviewerOwnedChanges,
  parseModelCatalog,
  parseProtectedPaths,
  checkModelSettings,
  resolveModelSettings,
  safetyBlockedBody,
  validateReview
} from './review-verdict.mjs';

const [, , command] = process.argv;

function output(pairs) {
  const lines = Object.entries(pairs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const commands = {
  prompt() {
    const prompt = buildReviewPrompt({
      repo: process.env.REPO || 'this repository',
      prNumber: process.env.PR_NUMBER || '',
      headSha: process.env.HEAD_SHA || '',
      baseRef: process.env.BASE_REF || 'main',
      headRef: process.env.HEAD_REF || '',
      taskRef: process.env.TASK_REF || '',
      contextDir: process.env.CONTEXT_DIR || '.review-context',
      projectContext: process.env.PROJECT_CONTEXT || '',
      reviewRules: process.env.REVIEW_RULES || '',
      testCommand: process.env.TEST_COMMAND || '',
      checkCommand: process.env.CHECK_COMMAND || ''
    });
    writeFileSync(process.env.PROMPT_FILE, prompt);
    console.log(`prompt: ${prompt.length} bytes -> ${process.env.PROMPT_FILE}`);
  },

  // Decide what the CLI run produced. `review` means a postable verdict; a
  // transient backend error is retryable; anything else is a hard failure.
  classify() {
    const stdout = readFileSync(process.env.RAW_FILE, 'utf8');
    const exitCode = Number(process.env.EXIT_CODE || 0);
    const result = classifyRun({ stdout, exitCode });
    if (result.kind === 'review') writeFileSync(process.env.MESSAGE_FILE, result.message);
    output({ kind: result.kind, verdict: result.verdict ?? '' });
    console.log(`classify: ${result.kind}${result.verdict ? ` verdict=${result.verdict}` : ''}`);
  },

  backoff() {
    console.log(String(backoffDelayMs(Number(process.env.ATTEMPT || 1))));
  },

  comment() {
    const head = process.env.HEAD_SHA || '';
    const raw = readFileSync(process.env.MESSAGE_FILE, 'utf8');
    const verdict = extractVerdict(raw);
    // No verdict line means the model produced prose or an error, not a review.
    if (!verdict) fail('The review agent ended without a structured verdict; refusing to post it as a review.');

    // A review names the model that produced it; without one there is nothing
    // truthful to post.
    if (!process.env.REVIEW_MODEL || !process.env.REVIEW_EFFORT) {
      fail('REVIEW_MODEL and REVIEW_EFFORT are unset; refusing to post a review that cannot name its model.');
    }

    const body = composeReviewComment({
      body: raw,
      head,
      verdict,
      model: process.env.REVIEW_MODEL,
      effort: process.env.REVIEW_EFFORT,
      runUrl: process.env.RUN_URL || '',
      // Only a verdict that asks for fixes is routed to the implementer; a PASS
      // has nothing to fix.
      route: process.env.ROUTE === 'true' && verdict !== 'pass',
      routingMarker: process.env.ROUTING_MARKER || ''
    });

    const check = validateReview({ body, head });
    if (!check.ok) fail(`Composed review failed validation: ${check.reason}`);

    writeFileSync(process.env.COMMENT_FILE, body);
    output({ verdict });
    console.log(`comment: verdict=${verdict} -> ${process.env.COMMENT_FILE}`);
  },

  failure() {
    const error = process.env.ERROR_FILE
      ? errorSummary({ stdout: readFileSync(process.env.ERROR_FILE, 'utf8') }) ||
        readFileSync(process.env.ERROR_FILE, 'utf8')
      : process.env.ERROR_TEXT || '';
    const body = automationFailureComment({
      head: process.env.HEAD_SHA || '',
      runUrl: process.env.RUN_URL || '',
      attempts: Number(process.env.ATTEMPTS || 0),
      error
    });
    writeFileSync(process.env.COMMENT_FILE, body);
    console.log(`failure comment -> ${process.env.COMMENT_FILE}`);
  },

  // Blocked when a PR edits the reviewer's own policy files.
  safety() {
    const files = JSON.parse(process.env.CHANGED_FILES || '[]');
    const owned = reviewerOwnedChanges(files, parseProtectedPaths(process.env.PROTECTED_PATHS));
    output({ blocked: owned.length > 0 ? 'true' : 'false', files: owned.join(' ') });
    console.log(`safety: reviewer-owned changes=[${owned.join(' ')}]`);
  },

  // Render the BLOCKED review for reviewer-owned changes.
  safetyComment() {
    const body = safetyBlockedBody({
      files: (process.env.OWNED_FILES || '').split(' ').filter(Boolean),
      head: process.env.HEAD_SHA || '',
      runUrl: process.env.RUN_URL || '',
      route: process.env.ROUTE === 'true',
      routingMarker: process.env.ROUTING_MARKER || ''
    });
    writeFileSync(process.env.COMMENT_FILE, body);
    output({ verdict: 'blocked' });
    console.log(`safety comment -> ${process.env.COMMENT_FILE}`);
  },

  labels() {
    const { add, remove } = labelTransitions({
      verdict: process.env.VERDICT || null,
      currentLabels: JSON.parse(process.env.CURRENT_LABELS || '[]'),
      onHead: process.env.ON_HEAD === 'true'
    });
    output({ add: add.join(' '), remove: remove.join(' ') });
    console.log(`labels: add=[${add.join(' ')}] remove=[${remove.join(' ')}]`);
  },

  missingLabels() {
    const missing = missingReviewLabels(JSON.parse(process.env.EXISTING_LABELS || '[]'));
    for (const { name, color, description } of missing) {
      console.log([name, color, description].join('\t'));
    }
  },

  // The caller passes its KINSHO_MODEL / KINSHO_EFFORT variables; unset ones are
  // empty strings and take the defaults. A model or effort the backend does not
  // offer stops the run here, before anything is posted or labelled.
  resolveModel() {
    const settings = resolveModelSettings({
      model: process.env.MODEL_INPUT,
      effort: process.env.EFFORT_INPUT
    });
    const catalog = parseModelCatalog(readFileSync(process.env.CATALOG_FILE, 'utf8'));
    const check = checkModelSettings(settings, catalog);
    if (!check.ok) fail(`${check.reason} Set the KINSHO_MODEL and KINSHO_EFFORT repository variables, or unset them for the defaults.`);
    output(settings);
    console.log(`model: ${settings.model} effort: ${settings.effort}`);
  },

  // Names only: a secret's value is never read beyond whether it is set.
  requireSecrets() {
    const missing = missingSecrets(process.env);
    if (missing.length > 0) {
      fail(`Kinsho secrets are unset: ${missing.join(', ')}. Pass them from the caller workflow before the reviewer can run.`);
    }
  }
};

const run = commands[command];
if (!run) fail(`Unknown command: ${command}`);
run();
