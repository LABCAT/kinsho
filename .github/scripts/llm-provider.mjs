// Optional OpenAI-compatible backend. When a caller sets `llm_base_url`, opencode
// talks to that endpoint through a custom provider instead of opencode-go. Pure
// functions only: the base URL and key reach opencode through the environment
// (`{env:...}` in the generated config), so neither is written to a file or log.
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './review-verdict.mjs';

export const LLM_PROVIDER_ID = 'kinsho-llm';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function llmBaseUrl(value) {
  return String(value ?? '').trim();
}

// Secrets the run needs: the LLM key on the custom path, the opencode key otherwise.
export function requiredSecretsFor(env = {}) {
  const apps = ['KINSHO_APP_ID', 'KINSHO_APP_PRIVATE_KEY'];
  return [llmBaseUrl(env.LLM_BASE_URL) ? 'LLM_API_KEY' : 'OPENCODE_API_KEY', ...apps];
}

export function missingSecretsFor(env = {}) {
  return requiredSecretsFor(env).filter((name) => !env[name]);
}

// Parse the base URL without ever echoing it back: reasons name the problem only.
export function parseBaseUrl(value) {
  const raw = llmBaseUrl(value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'llm_base_url is not a valid URL; use https://host/v1.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'llm_base_url must use https.' };
  if (url.username || url.password) {
    return { ok: false, reason: 'llm_base_url must not contain credentials; pass the key as the LLM_API_KEY secret.' };
  }
  return { ok: true, host: url.host, href: raw.replace(/\/+$/, '') };
}

// The model input is the id the endpoint knows (`deepseek-chat`), not provider/model.
// The workflow default names an opencode-go model, so it counts as unset here.
export function resolveLlmSettings({ model = '', effort = '' } = {}) {
  const id = String(model ?? '').trim();
  const level = String(effort ?? '').trim() || DEFAULT_EFFORT;
  if (!id || id === DEFAULT_MODEL) {
    return { ok: false, reason: 'llm_base_url is set, so `model` must name a model the endpoint serves (for example the id from its /models list); the opencode-go default does not apply.' };
  }
  if (/\s/.test(id)) return { ok: false, reason: `Model "${id}" must not contain whitespace.` };
  const bare = id.startsWith(`${LLM_PROVIDER_ID}/`) ? id.slice(LLM_PROVIDER_ID.length + 1) : id;
  if (!EFFORT_LEVELS.includes(level)) {
    return { ok: false, reason: `Effort "${level}" is not supported. Supported: ${EFFORT_LEVELS.join(', ')}.` };
  }
  return { ok: true, id: bare, effort: level, runModel: `${LLM_PROVIDER_ID}/${bare}` };
}

// opencode config for the custom provider. Nothing secret is inlined.
export function buildProviderConfig({ modelId }) {
  const variants = Object.fromEntries(EFFORT_LEVELS.map((level) => [level, { reasoningEffort: level }]));
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [LLM_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kinsho LLM',
        options: { baseURL: '{env:KINSHO_LLM_BASE_URL}', apiKey: '{env:LLM_API_KEY}' },
        models: { [modelId]: { name: modelId, variants } }
      }
    }
  };
}

// Ask the endpoint which models it serves. Fails closed, except where the
// endpoint has no model list (404/405/501): a wrong id then fails the run itself,
// and a failed run is never a PASS.
export async function checkRemoteModel({ baseUrl, apiKey, modelId, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    return { ok: false, reason: 'Could not reach the endpoint to list its models, so the model cannot be checked.' };
  }
  if ([404, 405, 501].includes(res.status)) return { ok: true, reason: 'The endpoint has no model list; the model is not pre-checked.' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: `The endpoint refused LLM_API_KEY (HTTP ${res.status}).` };
  }
  if (!res.ok) return { ok: false, reason: `The endpoint's model list failed (HTTP ${res.status}).` };
  let ids;
  try {
    const body = await res.json();
    ids = (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter((id) => typeof id === 'string');
  } catch {
    return { ok: false, reason: 'The endpoint returned a model list that could not be read.' };
  }
  if (ids.length === 0) return { ok: false, reason: 'The endpoint listed no models, so the model cannot be checked.' };
  if (!ids.includes(modelId)) {
    return { ok: false, reason: `Model "${modelId}" is not available. The endpoint offers: ${ids.slice(0, 12).join(', ')}.` };
  }
  return { ok: true, reason: 'ok' };
}
