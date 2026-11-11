import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LLM_PROVIDER_ID,
  buildProviderConfig,
  checkRemoteModel,
  missingSecretsFor,
  parseBaseUrl,
  resolveLlmSettings
} from './llm-provider.mjs';
import { DEFAULT_MODEL } from './review-verdict.mjs';

const APP = { KINSHO_APP_ID: '1', KINSHO_APP_PRIVATE_KEY: 'p' };
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('without llm_base_url, OPENCODE_API_KEY is required and LLM_API_KEY is not', () => {
  assert.deepEqual(missingSecretsFor({ ...APP }), ['OPENCODE_API_KEY']);
  assert.deepEqual(missingSecretsFor({ ...APP, OPENCODE_API_KEY: 'k' }), []);
  assert.deepEqual(missingSecretsFor({ ...APP, LLM_BASE_URL: '  ', OPENCODE_API_KEY: 'k' }), []);
});

test('with llm_base_url, LLM_API_KEY is required and OPENCODE_API_KEY is not', () => {
  const env = { ...APP, LLM_BASE_URL: 'https://api.example.com/v1' };
  assert.deepEqual(missingSecretsFor(env), ['LLM_API_KEY']);
  assert.deepEqual(missingSecretsFor({ ...env, OPENCODE_API_KEY: 'k' }), ['LLM_API_KEY']);
  assert.deepEqual(missingSecretsFor({ ...env, LLM_API_KEY: 'k' }), []);
  assert.deepEqual(missingSecretsFor({ LLM_BASE_URL: env.LLM_BASE_URL }), ['LLM_API_KEY', 'KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY']);
});

test('parseBaseUrl returns the host only and rejects credentials, http and junk without echoing them', () => {
  const ok = parseBaseUrl(' https://api.deeprelay.ai/v1/ ');
  assert.deepEqual(ok, { ok: true, host: 'api.deeprelay.ai', href: 'https://api.deeprelay.ai/v1' });
  for (const bad of ['', 'not a url', 'http://api.example.com/v1']) assert.equal(parseBaseUrl(bad).ok, false, bad);
  const creds = parseBaseUrl('https://user:hunter2secret@api.example.com/v1');
  assert.equal(creds.ok, false);
  assert.ok(!/hunter2secret|user/.test(creds.reason));
  assert.match(creds.reason, /credentials/);
});

test('resolveLlmSettings needs a real model and a known effort', () => {
  assert.equal(resolveLlmSettings({ model: '', effort: '' }).ok, false);
  const dflt = resolveLlmSettings({ model: DEFAULT_MODEL });
  assert.equal(dflt.ok, false);
  assert.match(dflt.reason, /`model` must name a model the endpoint serves/);
  assert.equal(resolveLlmSettings({ model: 'a b' }).ok, false);
  assert.match(resolveLlmSettings({ model: 'm', effort: 'turbo' }).reason, /"turbo" is not supported/);
  assert.deepEqual(resolveLlmSettings({ model: ' deepseek-chat ', effort: '' }), {
    ok: true, id: 'deepseek-chat', effort: 'high', runModel: `${LLM_PROVIDER_ID}/deepseek-chat`
  });
  // A model id that itself contains a slash stays whole.
  assert.equal(resolveLlmSettings({ model: 'org/model-x' }).runModel, `${LLM_PROVIDER_ID}/org/model-x`);
  assert.equal(resolveLlmSettings({ model: `${LLM_PROVIDER_ID}/m` }).id, 'm');
});

test('the provider config uses the openai-compatible package and takes URL and key from the environment', () => {
  const config = buildProviderConfig({ modelId: 'deepseek-chat' });
  const provider = config.provider[LLM_PROVIDER_ID];
  assert.equal(provider.npm, '@ai-sdk/openai-compatible');
  assert.equal(provider.options.baseURL, '{env:KINSHO_LLM_BASE_URL}');
  assert.equal(provider.options.apiKey, '{env:LLM_API_KEY}');
  assert.ok(provider.models['deepseek-chat']);
  assert.deepEqual(Object.keys(provider.models['deepseek-chat'].variants), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!/https?:\/\//.test(JSON.stringify(config.provider)));
});

test('checkRemoteModel accepts a listed model and sends the key only as a bearer header', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { status: 200, ok: true, json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) };
  };
  const result = await checkRemoteModel({ baseUrl: 'https://h.example/v1', apiKey: 'sekret-key', modelId: 'b', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(seen.url, 'https://h.example/v1/models');
  assert.equal(seen.init.headers.authorization, 'Bearer sekret-key');
});

test('checkRemoteModel fails closed: unknown model, bad key, outage, unreadable or empty list', async () => {
  const base = { baseUrl: 'https://h.example/v1', apiKey: 'sekret-key', modelId: 'zzz' };
  const unknown = await checkRemoteModel({ ...base, fetchImpl: reply(200, { data: [{ id: 'a' }] }) });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /"zzz" is not available.*a/);
  assert.match((await checkRemoteModel({ ...base, fetchImpl: reply(401, {}) })).reason, /refused LLM_API_KEY/);
  assert.equal((await checkRemoteModel({ ...base, fetchImpl: reply(502, {}) })).ok, false);
  assert.equal((await checkRemoteModel({ ...base, fetchImpl: reply(200, { data: [] }) })).ok, false);
  assert.equal((await checkRemoteModel({ ...base, fetchImpl: reply(200, 'x') })).ok, false);
  const down = await checkRemoteModel({ ...base, fetchImpl: async () => { throw new Error('boom sekret-key'); } });
  assert.equal(down.ok, false);
  assert.ok(!down.reason.includes('sekret-key'));
});

test('an endpoint with no model list is not pre-checked; the run itself fails on a wrong id', async () => {
  const result = await checkRemoteModel({ baseUrl: 'https://h.example/v1', apiKey: 'k', modelId: 'm', fetchImpl: reply(404, {}) });
  assert.equal(result.ok, true);
});

// Workflow wiring for the optional backend.
import { readFileSync } from 'node:fs';
import { composeReviewComment, parseMeta } from './review-verdict.mjs';
import { workflowSteps, workflowViolations } from './wiring-check.mjs';

const WORKFLOW = readFileSync(new URL('../workflows/review.yml', import.meta.url), 'utf8');

test('llm_base_url is an optional string input and both keys are optional secrets', () => {
  assert.match(WORKFLOW, /^ {6}llm_base_url:\n(?: {8}.+\n)*? {8}type: string\n {8}required: false\n {8}default: ''$/m);
  for (const name of ['OPENCODE_API_KEY', 'LLM_API_KEY']) {
    assert.match(WORKFLOW, new RegExp(`^ {6}${name}:\\n {8}description: .+\\n {8}required: false$`, 'm'), name);
  }
  assert.deepEqual(workflowViolations(WORKFLOW), []);
});

test('the secrets check and the model steps see the base URL; the model step gets the config path', () => {
  const steps = workflowSteps(WORKFLOW);
  const need = steps.find((s) => s.name === 'Require Kinsho secrets');
  assert.match(need.body, /LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/);
  assert.match(need.body, /LLM_BASE_URL: \$\{\{ inputs\.llm_base_url \}\}/);
  const resolve = steps.find((s) => s.name === 'Resolve model and effort');
  assert.match(resolve.body, /review-cli\.mjs resolveLlm/);
  assert.match(resolve.body, /review-cli\.mjs resolveModel/);
  const run = steps.find((s) => s.name === 'Run Kinsho review');
  assert.match(run.body, /OPENCODE_CONFIG: \$\{\{ steps\.model\.outputs\.config \}\}/);
  assert.match(run.body, /LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/);
});

test('the post steps refuse a comment carrying LLM_API_KEY, and nothing echoes the base URL', () => {
  for (const name of ['Post review comment', 'Report automation failure']) {
    const step = workflowSteps(WORKFLOW).find((s) => s.name === name);
    assert.match(step.body, /LEAK_LLM_API_KEY: \$\{\{ secrets\.LLM_API_KEY \}\}/, name);
  }
  assert.ok(!/echo[^\n]*(KINSHO_LLM_BASE_URL|LLM_BASE_URL)\}?"/.test(WORKFLOW.replace(/-n "\$\{[A-Z_]+\/\/[^}]*\}"/g, '')));
});

test('the review comment names the provider host when there is one, and only the host', () => {
  const body = composeReviewComment({
    body: `Looks fine.\n\nVerdict: PASS\nReviewed head: ${'a'.repeat(40)}`,
    head: 'a'.repeat(40), verdict: 'pass', model: 'deepseek-chat', effort: 'high', providerHost: 'api.deeprelay.ai'
  });
  assert.match(body, /model: deepseek-chat · effort: high · provider: api\.deeprelay\.ai/);
  assert.equal(parseMeta(body)?.verdict, 'pass');
  assert.doesNotMatch(composeReviewComment({ body: `x\n\nVerdict: PASS`, head: 'a'.repeat(40), verdict: 'pass', model: 'm', effort: 'high' }), /provider:/);
});
