// End-to-end validation of the workflow-facing CLI: the same subcommands the
// workflow runs, driven twice on one PR to prove two consecutive runs produce two
// separate comments and the correct label transitions.
//
// Run with: node --test .github/scripts/review-cli.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./review-cli.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kinsho-cli-'));
const HEAD = 'a'.repeat(40);
const ROUTING_MARKER = '<!-- route-to-implementer -->';
const MODEL = 'opencode-go/gpt-6-luna';
const EFFORT = 'high';

function runCli(command, env) {
  const outFile = join(dir, `out-${command}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(outFile, '');
  execFileSync(process.execPath, [CLI, command], {
    env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
    encoding: 'utf8'
  });
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
  return outputs;
}

function reviewRaw(verdict) {
  const file = join(dir, `raw-${verdict}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'step_start', part: { messageID: 'm1' } }),
      JSON.stringify({
        type: 'text',
        part: {
          messageID: 'm2',
          text: `**Verdict: ${verdict.toUpperCase()}**\n\n1. \`src/x.js:1\` — fix it.`
        }
      }),
      JSON.stringify({ type: 'text', part: { messageID: 'm2', text: `Reviewed HEAD: \`${HEAD}\`` } })
    ].join('\n')
  );
  return file;
}

test('two consecutive runs post two separate comments with correct label transitions', () => {
  // Run 1: BLOCKED.
  const messageFile1 = join(dir, 'message-1.md');
  const classified1 = runCli('classify', {
    RAW_FILE: reviewRaw('blocked'),
    EXIT_CODE: '0',
    MESSAGE_FILE: messageFile1
  });
  assert.equal(classified1.kind, 'review');
  assert.equal(classified1.verdict, 'blocked');

  const commentFile1 = join(dir, 'comment-1.md');
  runCli('comment', {
    MESSAGE_FILE: messageFile1,
    HEAD_SHA: HEAD,
    REVIEW_MODEL: MODEL,
    REVIEW_EFFORT: EFFORT,
    ROUTE: 'true',
    ROUTING_MARKER,
    COMMENT_FILE: commentFile1
  });
  const comment1 = readFileSync(commentFile1, 'utf8');
  assert.match(comment1, /^## Kinsho review/);
  assert.match(comment1, /Verdict: BLOCKED/);
  assert.ok(comment1.includes(ROUTING_MARKER));

  const labels1 = runCli('labels', {
    VERDICT: classified1.verdict,
    CURRENT_LABELS: '[]',
    ON_HEAD: 'true'
  });
  assert.equal(labels1.add, 'review:blocked');
  assert.equal(labels1.remove, '');

  // Run 2 on the same PR: PASS. A new head, so the earlier verdict label clears.
  const messageFile2 = join(dir, 'message-2.md');
  const classified2 = runCli('classify', {
    RAW_FILE: reviewRaw('pass'),
    EXIT_CODE: '0',
    MESSAGE_FILE: messageFile2
  });
  assert.equal(classified2.verdict, 'pass');

  const commentFile2 = join(dir, 'comment-2.md');
  runCli('comment', {
    MESSAGE_FILE: messageFile2,
    HEAD_SHA: HEAD,
    REVIEW_MODEL: MODEL,
    REVIEW_EFFORT: EFFORT,
    ROUTE: 'true',
    ROUTING_MARKER,
    COMMENT_FILE: commentFile2
  });
  const comment2 = readFileSync(commentFile2, 'utf8');

  // Two distinct comment bodies: the workflow posts each as a new comment.
  assert.notEqual(comment1, comment2);
  assert.match(comment2, /Verdict: PASS/);
  // A PASS is not routed back to the implementer.
  assert.ok(!comment2.includes(ROUTING_MARKER));

  const labels2 = runCli('labels', {
    VERDICT: classified2.verdict,
    CURRENT_LABELS: '["review:blocked"]',
    ON_HEAD: 'true'
  });
  assert.equal(labels2.add, 'pr-ready');
  assert.equal(labels2.remove, 'review:blocked');
});

test('missingLabels prints one tab-separated row per absent review label', () => {
  const stdout = execFileSync(process.execPath, [CLI, 'missingLabels'], {
    env: { ...process.env, EXISTING_LABELS: '["pr-ready","review:blocked"]' },
    encoding: 'utf8'
  });
  const rows = stdout.trim().split('\n').map((line) => line.split('\t'));
  assert.deepEqual(
    rows.map(([name]) => name),
    ['review:needs-evidence', 'review:automation-failed']
  );
  // Every row carries the colour and description `gh label create` needs.
  for (const row of rows) assert.equal(row.length, 3);

  const none = execFileSync(process.execPath, [CLI, 'missingLabels'], {
    env: {
      ...process.env,
      EXISTING_LABELS: '["pr-ready","review:blocked","review:needs-evidence","review:automation-failed"]'
    },
    encoding: 'utf8'
  });
  assert.equal(none, '');
});

test('a transient backend failure is retryable and never becomes a comment', () => {
  const rawFile = join(dir, 'raw-transient.jsonl');
  writeFileSync(
    rawFile,
    JSON.stringify({
      type: 'error',
      error: { name: 'APIError', data: { message: 'The backend is temporarily overloaded.', isRetryable: true } }
    })
  );

  const classified = runCli('classify', {
    RAW_FILE: rawFile,
    EXIT_CODE: '1',
    MESSAGE_FILE: join(dir, 'never-written.md')
  });
  assert.equal(classified.kind, 'transient');
  // The workflow only runs `comment` for a review, so no comment is produced.
  assert.equal(classified.verdict, '');
});

test('the failure path renders an explicit non-verdict notice', () => {
  const rawFile = join(dir, 'raw-401.jsonl');
  writeFileSync(
    rawFile,
    JSON.stringify({
      type: 'error',
      error: {
        name: 'APIError',
        data: { message: 'Upstream request failed: Invalid credential', statusCode: 401, isRetryable: false }
      }
    })
  );

  const commentFile = join(dir, 'failure.md');
  runCli('failure', {
    ERROR_FILE: rawFile,
    HEAD_SHA: HEAD,
    ATTEMPTS: '3',
    COMMENT_FILE: commentFile
  });

  const body = readFileSync(commentFile, 'utf8');
  assert.match(body, /Verdict: NONE — automation failure/);
  assert.match(body, /not a reviewer verdict/);
  assert.match(body, /Invalid credential/);
  // Never the raw JSON event blob.
  assert.doesNotMatch(body, /\{"type":"error"/);
});

test('requireSecrets names each unset secret, exits non-zero, and never prints a value', () => {
  const run = (env) => {
    const clean = { ...process.env, OPENCODE_API_KEY: '', KINSHO_APP_ID: '', KINSHO_APP_PRIVATE_KEY: '', ...env };
    return spawnSync(process.execPath, [CLI, 'requireSecrets'], { env: clean, encoding: 'utf8' });
  };

  const none = run({});
  assert.equal(none.status, 1);
  assert.match(none.stderr, /::error::/);
  for (const name of ['OPENCODE_API_KEY', 'KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY']) {
    assert.ok(none.stderr.includes(name), name);
  }

  // One missing: only that one is named, and the values that are set stay out.
  const partial = run({ OPENCODE_API_KEY: 'value-of-key', KINSHO_APP_ID: 'value-of-id' });
  assert.equal(partial.status, 1);
  assert.ok(partial.stderr.includes('KINSHO_APP_PRIVATE_KEY'));
  assert.ok(!partial.stderr.includes('OPENCODE_API_KEY'));
  assert.ok(!partial.stderr.includes('value-of'));
  assert.ok(!partial.stdout.includes('value-of'));

  const all = run({ OPENCODE_API_KEY: 'k', KINSHO_APP_ID: 'i', KINSHO_APP_PRIVATE_KEY: 'p' });
  assert.equal(all.status, 0);
});

test('safety applies the caller protected paths, and a bad regex fails the step', () => {
  const blocked = runCli('safety', {
    CHANGED_FILES: '["src/a.js","deploy/gate.mjs"]',
    PROTECTED_PATHS: '^deploy/\n'
  });
  assert.equal(blocked.blocked, 'true');
  assert.equal(blocked.files, 'deploy/gate.mjs');

  const clear = runCli('safety', { CHANGED_FILES: '["src/a.js"]', PROTECTED_PATHS: '' });
  assert.equal(clear.blocked, 'false');

  assert.throws(() => runCli('safety', { CHANGED_FILES: '["src/a.js"]', PROTECTED_PATHS: '(' }));
});

const CATALOG_FILE = join(dir, 'models.txt');
writeFileSync(
  CATALOG_FILE,
  [
    'opencode-go/gpt-6-luna',
    JSON.stringify({ variants: { low: {}, high: {}, max: {} } }, null, 2),
    'opencode-go/kimi-k3',
    JSON.stringify({ variants: { high: {} } }, null, 2)
  ].join('\n')
);

function resolveModel(env) {
  const clean = { ...process.env, CATALOG_FILE };
  delete clean.MODEL_INPUT;
  delete clean.EFFORT_INPUT;
  const outFile = join(dir, `resolve-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(outFile, '');
  const result = spawnSync(process.execPath, [CLI, 'resolveModel'], {
    env: { ...clean, GITHUB_OUTPUT: outFile, ...env },
    encoding: 'utf8'
  });
  return { ...result, outputs: readFileSync(outFile, 'utf8') };
}

test('resolveModel: variables unset or empty give the defaults', () => {
  for (const env of [{}, { MODEL_INPUT: '', EFFORT_INPUT: '' }]) {
    const result = resolveModel(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `model=${MODEL}\neffort=${EFFORT}\n`);
  }
});

test('resolveModel: set variables win', () => {
  const result = resolveModel({ MODEL_INPUT: 'opencode-go/kimi-k3', EFFORT_INPUT: 'high' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs, 'model=opencode-go/kimi-k3\neffort=high\n');

  const effortOnly = resolveModel({ EFFORT_INPUT: 'max' });
  assert.equal(effortOnly.outputs, `model=${MODEL}\neffort=max\n`);
});

test('resolveModel: an unknown model or effort fails the step with a clear message and no outputs', () => {
  for (const [env, message] of [
    [{ MODEL_INPUT: 'opencode-go/nope' }, /Model "opencode-go\/nope" is not available/],
    [{ MODEL_INPUT: 'nope' }, /must look like provider\/model/],
    [{ EFFORT_INPUT: 'turbo' }, /Effort "turbo" is not supported by opencode-go\/gpt-6-luna/],
    [{ MODEL_INPUT: 'opencode-go/kimi-k3', EFFORT_INPUT: 'max' }, /Supported: high/]
  ]) {
    const result = resolveModel(env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::/);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /KINSHO_MODEL and KINSHO_EFFORT/);
    assert.equal(result.outputs, '');
  }
});

test('resolveModel: an empty model list fails rather than skipping the check', () => {
  writeFileSync(CATALOG_FILE, '');
  try {
    const result = resolveModel({});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not list the available models/);
  } finally {
    writeFileSync(CATALOG_FILE, 'opencode-go/gpt-6-luna\n{"variants":{"high":{}}}');
  }
});

test('comment: refuses to post a review that cannot name its model', () => {
  const message = join(dir, 'message-nomodel.md');
  writeFileSync(message, '**Verdict: PASS**\nReviewed HEAD: `' + HEAD + '`\nok');
  const result = spawnSync(process.execPath, [CLI, 'comment'], {
    env: { ...process.env, MESSAGE_FILE: message, HEAD_SHA: HEAD, COMMENT_FILE: join(dir, 'c.md'), REVIEW_MODEL: '', REVIEW_EFFORT: '' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REVIEW_MODEL and REVIEW_EFFORT are unset/);
});
