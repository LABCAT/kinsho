// Evidence policy: author claims never count, runtime changes need CI runtime
// evidence on the head, and a configured gate overrides a model PASS.
//
// Run with: node --test .github/scripts/review-evidence.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyEvidenceGate,
  evaluateEvidence,
  isExemptPath,
  parseEvidenceChecks,
  pendingEvidenceChecks,
  runtimeChanges
} from './review-evidence.mjs';
import { buildReviewPrompt, validateReview } from './review-verdict.mjs';

const HEAD = 'c'.repeat(40);
const CLI = fileURLToPath(new URL('./review-cli.mjs', import.meta.url));
const WORKFLOW = readFileSync(new URL('../workflows/review.yml', import.meta.url), 'utf8');
const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

function fileDiff(path, added = ['x'], removed = [], from = path) {
  return [
    `diff --git a/${from} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${from}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    ' context line',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`)
  ].join('\n');
}

function run(name, conclusion = 'success', { id = 1, status = 'completed' } = {}) {
  return { id, name, status, conclusion: status === 'completed' ? conclusion : null };
}

function checks(runs, head = HEAD, error = null) {
  return { head, error, check_runs: runs };
}

// Shape of LABCAT/mission-control#7 at 575ff5a: access-control and plugin changes,
// a body that claims "/admin redirects to login", and CI that only typechecked,
// built and published a preview. No check loaded /admin.
const PR7_DIFF = [
  fileDiff('apps/cms/src/collections/Users.ts', ['  update: selfOrTenantAdmin,'], ['  update: authenticatedAccess,']),
  fileDiff('apps/cms/src/payload.config.ts', ['    multiTenantPlugin({ collections }),']),
  fileDiff('apps/cms/package.json', ['    "@payloadcms/plugin-multi-tenant": "4.0.0-beta.7",']),
  fileDiff('apps/cms/src/tenancy.test.ts', ['test("isolation", () => {})'])
].join('\n');
const PR7_CHECKS = checks([
  run('Typecheck, lint, test, build', 'success', { id: 10 }),
  run('Publish preview', 'success', { id: 11 }),
  run('Delete preview', 'skipped', { id: 12 })
]);
const PR7_PASS = [
  '## Kinsho review',
  '',
  '**Verdict: PASS**',
  `Reviewed HEAD: \`${HEAD}\``,
  '',
  'No findings. The PR body reports `/admin` redirects to login and the preview smoke passed.'
].join('\n');

test('evidence_checks parses one name per line, trimmed and de-duplicated', () => {
  assert.deepEqual(parseEvidenceChecks(' e2e / admin smoke \n\n e2e / admin smoke\nPlaywright\n'), ['e2e / admin smoke', 'Playwright']);
  assert.deepEqual(parseEvidenceChecks(''), []);
  assert.deepEqual(parseEvidenceChecks(undefined), []);
});

test('docs and tests are exempt; app code, config, deps and migrations are not', () => {
  for (const path of ['README.md', 'docs/setup.png', 'src/a.test.ts', 'apps/x/__tests__/a.js', 'e2e/admin.spec.ts', 'pkg/x_test.go', 'LICENSE']) {
    assert.ok(isExemptPath(path), path);
  }
  for (const path of [
    'src/index.ts',
    'wrangler.jsonc',
    'package.json',
    'pnpm-lock.yaml',
    'apps/cms/src/migrations/20261105_multi_tenancy.ts',
    'src/access/testUser.ts',
    '.github/workflows/ci.yml'
  ]) {
    assert.ok(!isExemptPath(path), path);
  }
});

test('comment-only changes to code are exempt; a code line among them is not', () => {
  assert.deepEqual(runtimeChanges(fileDiff('src/a.ts', ['// explain why', '  /* note */', '   * jsdoc line'], ['// old'])), []);
  assert.deepEqual(runtimeChanges(fileDiff('deploy.yml', ['# a yaml comment', ''])), []);
  assert.deepEqual(runtimeChanges(fileDiff('src/a.ts', ['// explain', 'const x = 1;'])), ['src/a.ts']);
  // `#include` and a shebang are code, not comments.
  assert.deepEqual(runtimeChanges(fileDiff('src/a.c', ['#include <x.h>'])), ['src/a.c']);
  assert.deepEqual(runtimeChanges(fileDiff('bin/run', ['#!/bin/sh'])), ['bin/run']);
});

test('a rename, a binary or an empty change is not provably inert', () => {
  assert.deepEqual(runtimeChanges(fileDiff('src/b.ts', ['// same'], ['// same'], 'src/a.ts')), ['src/b.ts']);
  assert.deepEqual(runtimeChanges('diff --git a/assets/logo.png b/assets/logo.png\nBinary files a/assets/logo.png and b/assets/logo.png differ'), ['assets/logo.png']);
  assert.deepEqual(runtimeChanges('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755'), ['run.sh']);
  // Moving a runtime file into a test directory still removes it from runtime.
  assert.deepEqual(runtimeChanges(fileDiff('tests/old.ts', ['x'], [], 'src/old.ts')), ['tests/old.ts']);
});

test('no evidence_checks configured: the gate does not apply (model judgement)', () => {
  const gate = evaluateEvidence({ diff: PR7_DIFF, checks: PR7_CHECKS, required: [], head: HEAD });
  assert.equal(gate.ok, true);
  assert.equal(gate.applies, false);
});

test('mission-control#7: author claims and build-only CI cannot PASS a runtime change', () => {
  const gate = evaluateEvidence({ diff: PR7_DIFF, checks: PR7_CHECKS, required: ['e2e / admin smoke'], head: HEAD });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.runtime, ['apps/cms/src/collections/Users.ts', 'apps/cms/src/payload.config.ts', 'apps/cms/package.json']);
  assert.deepEqual(gate.missing, [{ name: 'e2e / admin smoke', state: 'missing' }]);

  const gated = applyEvidenceGate({ verdict: 'pass', body: PR7_PASS, gate, head: HEAD });
  assert.equal(gated.verdict, 'needs-evidence');
  assert.equal(gated.downgraded, true);
  assert.ok(!gated.body.includes('**Verdict: PASS**'));
  assert.ok(gated.body.includes('**Verdict: NEEDS_EVIDENCE**'));
  assert.ok(gated.body.includes('- `e2e / admin smoke`: missing'));
  assert.ok(gated.body.includes('Author statements are not evidence'));
});

test('a green evidence check on the head lets the PASS stand', () => {
  const ok = checks([...PR7_CHECKS.check_runs, run('e2e / admin smoke', 'success', { id: 20 })]);
  const gate = evaluateEvidence({ diff: PR7_DIFF, checks: ok, required: ['e2e / admin smoke'], head: HEAD });
  assert.equal(gate.ok, true);
  const gated = applyEvidenceGate({ verdict: 'pass', body: PR7_PASS, gate, head: HEAD });
  assert.equal(gated.verdict, 'pass');
  assert.equal(gated.body, PR7_PASS);
});

test('only completed + success counts: skipped, neutral, failed and pending do not', () => {
  for (const [state, runs] of [
    ['skipped', [run('e2e', 'skipped')]],
    ['neutral', [run('e2e', 'neutral')]],
    ['failure', [run('e2e', 'failure')]],
    ['cancelled', [run('e2e', 'cancelled')]],
    ['pending', [run('e2e', null, { status: 'in_progress' })]]
  ]) {
    const gate = evaluateEvidence({ diff: PR7_DIFF, checks: checks(runs), required: ['e2e'], head: HEAD });
    assert.equal(gate.ok, false, state);
    assert.deepEqual(gate.missing, [{ name: 'e2e', state }]);
  }
});

test('every named check must pass, and the latest re-run wins', () => {
  const required = ['e2e', 'smoke'];
  const partial = evaluateEvidence({ diff: PR7_DIFF, checks: checks([run('e2e')]), required, head: HEAD });
  assert.deepEqual(partial.missing, [{ name: 'smoke', state: 'missing' }]);

  const rerunFixed = checks([run('e2e', 'failure', { id: 1 }), run('e2e', 'success', { id: 2 }), run('smoke')]);
  assert.equal(evaluateEvidence({ diff: PR7_DIFF, checks: rerunFixed, required, head: HEAD }).ok, true);

  const rerunBroke = checks([run('e2e', 'success', { id: 2 }), run('e2e', 'failure', { id: 3 }), run('smoke')]);
  assert.deepEqual(evaluateEvidence({ diff: PR7_DIFF, checks: rerunBroke, required, head: HEAD }).missing, [{ name: 'e2e', state: 'failure' }]);
});

test('check names match exactly, not by substring or case', () => {
  const gate = evaluateEvidence({ diff: PR7_DIFF, checks: checks([run('e2e (skipped tests)'), run('E2E')]), required: ['e2e'], head: HEAD });
  assert.equal(gate.ok, false);
});

test('fails closed: unreadable checks, a stale head, or a missing diff', () => {
  const unreadable = evaluateEvidence({ diff: PR7_DIFF, checks: null, required: ['e2e'], head: HEAD });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /could not be read/);

  const errored = evaluateEvidence({ diff: PR7_DIFF, checks: checks([run('e2e')], HEAD, 'no checks token'), required: ['e2e'], head: HEAD });
  assert.equal(errored.ok, false);
  assert.match(errored.reason, /no checks token/);

  const stale = evaluateEvidence({ diff: PR7_DIFF, checks: checks([run('e2e')], 'd'.repeat(40)), required: ['e2e'], head: HEAD });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.missing, [{ name: 'e2e', state: 'stale' }]);

  const noDiff = evaluateEvidence({ diff: null, checks: checks([]), required: ['e2e'], head: HEAD });
  assert.equal(noDiff.ok, false);
});

test('a PR that edits CI definitions cannot vouch for itself', () => {
  const diff = [PR7_DIFF, fileDiff('.github/workflows/e2e.yml', ['      - run: echo ok'])].join('\n');
  const gate = evaluateEvidence({ diff, checks: checks([run('e2e')]), required: ['e2e'], head: HEAD });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /edits CI definitions/);
  assert.deepEqual(gate.missing, [{ name: 'e2e', state: 'untrusted' }]);
});

test('docs-, test- and comment-only PRs PASS with no evidence checks run', () => {
  const diff = [fileDiff('README.md'), fileDiff('src/a.test.ts'), fileDiff('src/a.ts', ['// why'])].join('\n');
  const gate = evaluateEvidence({ diff, checks: checks([]), required: ['e2e'], head: HEAD });
  assert.equal(gate.ok, true);
  assert.equal(applyEvidenceGate({ verdict: 'pass', body: PR7_PASS, gate, head: HEAD }).verdict, 'pass');
});

test('the gate never touches BLOCKED or NEEDS_EVIDENCE, and is idempotent', () => {
  const gate = evaluateEvidence({ diff: PR7_DIFF, checks: PR7_CHECKS, required: ['e2e'], head: HEAD });
  for (const verdict of ['blocked', 'needs-evidence']) {
    const out = applyEvidenceGate({ verdict, body: 'x', gate, head: HEAD });
    assert.deepEqual(out, { verdict, body: 'x', downgraded: false });
  }
  const once = applyEvidenceGate({ verdict: 'pass', body: PR7_PASS, gate, head: HEAD });
  const twice = applyEvidenceGate({ verdict: once.verdict, body: once.body, gate, head: HEAD });
  assert.equal(twice.body, once.body);
});

test('pending evidence checks: missing or running are pending; finished ones are not', () => {
  const state = checks([run('a'), run('b', 'failure'), run('c', null, { status: 'queued' })]);
  assert.deepEqual(pendingEvidenceChecks(state, ['a', 'b', 'c', 'd']), ['c', 'd']);
  assert.deepEqual(pendingEvidenceChecks(null, ['a']), ['a']);
  assert.deepEqual(pendingEvidenceChecks(state, []), []);
});

test('the prompt says author claims are not evidence and names configured checks', () => {
  const plain = buildReviewPrompt({ prNumber: '7', headSha: HEAD });
  assert.ok(plain.includes('claims, not evidence'));
  assert.ok(plain.includes('"redirects to login"'));
  assert.ok(plain.includes(`check runs CI recorded on head \`${HEAD}\``));
  assert.ok(plain.includes('Docs-only, test-only and comment-only'));
  assert.ok(plain.includes('checks.json'));
  assert.ok(!plain.includes('live-run statement'));
  assert.ok(!plain.includes('names its runtime evidence checks'));

  const gated = buildReviewPrompt({ prNumber: '7', headSha: HEAD, evidenceChecks: ['e2e / admin smoke'] });
  assert.ok(gated.includes('names its runtime evidence checks: `e2e / admin smoke`.'));
});

function cliComment(env) {
  const dir = mkdtempSync(join(tmpdir(), 'kinsho-evidence-'));
  const files = {
    MESSAGE_FILE: join(dir, 'message.md'),
    COMMENT_FILE: join(dir, 'comment.md'),
    DIFF_FILE: join(dir, 'pr.diff'),
    CHECKS_FILE: join(dir, 'checks.json'),
    GITHUB_OUTPUT: join(dir, 'out.txt')
  };
  writeFileSync(files.MESSAGE_FILE, PR7_PASS);
  writeFileSync(files.DIFF_FILE, PR7_DIFF);
  writeFileSync(files.CHECKS_FILE, JSON.stringify(PR7_CHECKS));
  writeFileSync(files.GITHUB_OUTPUT, '');
  const { checksFile, ...rest } = env;
  if (checksFile !== undefined) writeFileSync(files.CHECKS_FILE, checksFile);
  execFileSync(process.execPath, [CLI, 'comment'], {
    env: { ...process.env, ...files, HEAD_SHA: HEAD, REVIEW_MODEL: 'opencode-go/gpt-6-luna', REVIEW_EFFORT: 'high', ...rest },
    encoding: 'utf8'
  });
  return {
    body: readFileSync(files.COMMENT_FILE, 'utf8'),
    output: readFileSync(files.GITHUB_OUTPUT, 'utf8')
  };
}

test('CLI comment: the posted verdict and meta marker are the gated ones', () => {
  const { body, output } = cliComment({ EVIDENCE_CHECKS: 'e2e / admin smoke' });
  assert.match(output, /^verdict=needs-evidence$/m);
  assert.ok(body.includes('"verdict":"needs-evidence"'));
  assert.deepEqual(validateReview({ body, head: HEAD }), { ok: true, verdict: 'needs-evidence', reason: 'ok' });
});

test('CLI comment: unparseable checks.json fails closed', () => {
  const { output } = cliComment({ EVIDENCE_CHECKS: 'e2e', checksFile: '{not json' });
  assert.match(output, /^verdict=needs-evidence$/m);
});

test('CLI comment: no evidence_checks leaves the model verdict as posted', () => {
  const { output } = cliComment({ EVIDENCE_CHECKS: '' });
  assert.match(output, /^verdict=pass$/m);
});

test('the workflow labels the gated verdict and feeds the gate an untouched copy', () => {
  assert.match(WORKFLOW, /^ {6}evidence_checks:$/m);
  assert.match(WORKFLOW, /^ {6}evidence_wait_minutes:$/m);
  const labels = WORKFLOW.slice(WORKFLOW.indexOf('- name: Apply review labels'), WORKFLOW.indexOf('- name: Update labels'));
  assert.ok(labels.includes('VERDICT: ${{ steps.post.outputs.verdict }}'));
  assert.ok(!labels.includes('steps.run.outputs.verdict'));
  const post = WORKFLOW.slice(WORKFLOW.indexOf('- name: Post review comment'), WORKFLOW.indexOf('- name: Apply review labels'));
  assert.ok(post.includes('CHECKS_FILE: ${{ runner.temp }}/kinsho-evidence/checks.json'));
  assert.ok(post.includes('DIFF_FILE: ${{ runner.temp }}/kinsho-evidence/pr.diff'));
  assert.ok(post.includes('EVIDENCE_CHECKS: ${{ inputs.evidence_checks }}'));
  // Checks are collected before the model runs, and this run's own job is excluded.
  assert.ok(WORKFLOW.indexOf('check-runs?per_page=100') < WORKFLOW.indexOf('- name: Run Kinsho review'));
  assert.ok(WORKFLOW.includes('/actions/runs/${GITHUB_RUN_ID}/'));
});

test('the README documents evidence_checks and the Evidence rule', () => {
  assert.ok(README.includes('| `evidence_checks` |'));
  assert.ok(README.includes('| `evidence_wait_minutes` |'));
  assert.ok(README.includes('## Evidence'));
});
