// One `generate()` for every model provider. Ollama (local, free) is the default;
// Claude, OpenAI and Gemini work with your own API key (Settings → AI model).
import { config } from './config.js';

export const PROVIDERS = {
  ollama: { label: 'Ollama (local, free)', key: null, defaultModel: 'qwen2.5:3b',
    models: [['qwen2.5:3b', 'Qwen 2.5 3B — fast, runs on 8 GB'], ['qwen2.5:7b', 'Qwen 2.5 7B — better writing, needs ~8 GB free'], ['llama3.2:3b', 'Llama 3.2 3B — fast'], ['llama3.1:8b', 'Llama 3.1 8B — better writing'], ['gemma2:9b', 'Gemma 2 9B — strong, needs 16 GB']] },
  anthropic: { label: 'Claude', key: 'ANTHROPIC_API_KEY', defaultModel: 'claude-haiku-5-5',
    models: [['claude-haiku-5-5', 'Claude Haiku 5.5 — fast and cheap'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — best balance'], ['claude-opus-5-5', 'Claude Opus 5.5 — highest quality']] },
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', defaultModel: 'gpt-4.1-mini',
    models: [['gpt-4.1-mini', 'GPT-4.1 mini — fast and cheap'], ['gpt-4.1', 'GPT-4.1 — higher quality'], ['gpt-4o-mini', 'GPT-4o mini — cheapest']] },
  gemini: { label: 'Gemini', key: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-flash',
    models: [['gemini-2.5-flash', 'Gemini 2.5 Flash — fast, has a free tier'], ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite — cheapest'], ['gemini-2.5-pro', 'Gemini 2.5 Pro — highest quality']] },
};
// Models already installed in Ollama on this Mac.
export async function installedOllamaModels() {
  try { const r = await fetch(`${config.llm.host}/api/tags`, { signal: AbortSignal.timeout(3000) }); return (await r.json()).models.map((m) => m.name); } catch { return []; }
}
const provider = () => (PROVIDERS[config.llm.provider] ? config.llm.provider : 'ollama');
export const currentModel = () => (provider() === 'ollama' ? config.llm.model : config.llm.models?.[provider()] || PROVIDERS[provider()].defaultModel);
export const usage = { calls: 0, inTok: 0, outTok: 0 };

const JSON_HINT = '\n\nRespond with a single JSON object only — no prose, no code fences.';

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${provider()} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function generate(prompt, { json = false, temperature = 0.4, maxTokens = 500 } = {}) {
  const p = provider(), model = currentModel();
  usage.calls++;
  if (p === 'ollama') {
    const j = await post(`${config.llm.host}/api/generate`, {}, {
      model, prompt, stream: false, format: json ? 'json' : undefined, options: { temperature, num_predict: maxTokens, num_ctx: 4096 },
    });
    return j.response.trim();
  }
  const key = process.env[PROVIDERS[p].key];
  if (!key) throw new Error(`No ${PROVIDERS[p].label} API key — add one in Settings → AI model`);
  if (p === 'anthropic') {
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt + (json ? JSON_HINT : '') }],
    });
    usage.inTok += j.usage?.input_tokens || 0; usage.outTok += j.usage?.output_tokens || 0;
    return j.content.map((c) => c.text || '').join('').trim();
  }
  if (p === 'openai') {
    const j = await post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` }, {
      model, temperature, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt + (json ? JSON_HINT : '') }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });
    usage.inTok += j.usage?.prompt_tokens || 0; usage.outTok += j.usage?.completion_tokens || 0;
    return j.choices[0].message.content.trim();
  }
  if (p === 'gemini') {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    });
    usage.inTok += j.usageMetadata?.promptTokenCount || 0; usage.outTok += j.usageMetadata?.candidatesTokenCount || 0;
    return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
  }
  throw new Error(`Unknown provider ${p}`);
}

// Pull the first JSON object out of a reply (cloud models sometimes wrap it in prose or fences).
function extractJSON(raw) {
  try { return JSON.parse(raw); } catch {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(raw.slice(s, e + 1));
  throw new Error('no JSON in reply');
}

export async function generateJSON(prompt, fallback, opts = {}) {
  let raw = '';
  try {
    raw = await generate(prompt, { ...opts, json: true });
    return { ...fallback, ...extractJSON(raw) };
  } catch (e) {
    // Small models sometimes run past the token limit — salvage any complete "key": "value" pairs.
    const salvaged = {};
    for (const k of Object.keys(fallback)) {
      const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (m) { try { salvaged[k] = JSON.parse(`"${m[1]}"`); } catch {} }
    }
    if (Object.keys(salvaged).length) return { ...fallback, ...salvaged };
    console.warn('[llm] falling back:', e.message);
    return fallback;
  }
}

export async function llmAvailable() {
  const p = provider();
  if (p !== 'ollama') return Boolean(process.env[PROVIDERS[p].key]);
  try {
    const r = await fetch(`${config.llm.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const { models } = await r.json();
    return models.some((m) => m.name.startsWith(config.llm.model.split(':')[0]));
  } catch { return false; }
}

// Settings → AI model → Test: a tiny round trip.
export async function testModel() {
  const t = Date.now();
  const out = await generateJSON('Reply with {"ok": true}.', { ok: false }, { maxTokens: 20, temperature: 0 });
  return { ok: out.ok === true, ms: Date.now() - t, model: currentModel(), provider: provider() };
}

export const clip = (s, n = 2500) => (s || '').replace(/\s+/g, ' ').slice(0, n);
