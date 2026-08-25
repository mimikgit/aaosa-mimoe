// Minimal OpenAI-compatible chat client. Zero dependencies, Node 18+.
// Points at a node-local mimOE inference endpoint (or any OpenAI-compatible URL).

'use strict';

/**
 * @param {object} opts
 * @param {string} opts.baseUrl    e.g. process.env.INFERENCE_URL
 * @param {string} [opts.apiKey]   usually unused for node-local endpoints
 * @param {function} [opts.postJson] async (url, body, timeoutMs) => object.
 *                                 Transport override; REQUIRED inside mimOE
 *                                 serverless (wrap context.http.request).
 * @param {number} [opts.maxTokens] cap on generated tokens per call (env
 *                                 INFERENCE_MAX_TOKENS). Raise it if routing
 *                                 JSON or answers come back truncated
 *                                 (finish_reason "length"): a thinking model
 *                                 can spend the default budget reasoning and
 *                                 truncate its own output.
 * @param {boolean} [opts.enableThinking=false] whether to let the model reason
 *                                 (env INFERENCE_ENABLE_THINKING=1). Off by
 *                                 default: this Qwen build otherwise emits a
 *                                 long reasoning_content and only fills
 *                                 `content` afterward, making calls 20-40s and
 *                                 empty when reasoning overruns the budget.
 * @param {number} [opts.timeoutMs=20000] per-call inference timeout in ms (env
 *                                 INFERENCE_TIMEOUT_MS). Raise it if the model
 *                                 is slow or thinking is on. NOTE: if PEERS time
 *                                 out ('unreachable'), raise DEADLINE_MS too — a
 *                                 consult includes the peer's own inference call.
 */
function makeLlm({ baseUrl, apiKey, postJson, maxTokens, enableThinking = false, timeoutMs: defaultTimeoutMs = 20000 }) {
  if (!baseUrl) throw new Error('llm: baseUrl is required (set INFERENCE_URL)');

  async function chat({ model, system, user, json = false, timeoutMs = defaultTimeoutMs }) {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const payload = {
      model,
      // Disable chain-of-thought. This milm/Qwen build otherwise emits a long
      // reasoning_content and only fills `content` afterward — making every
      // call 20-40s and returning empty `content` whenever the reasoning
      // overruns the token budget. Top-level enable_thinking:false is the
      // switch this runtime honors (chat_template_kwargs and reasoning_effort
      // are ignored here). Set INFERENCE_ENABLE_THINKING=1 to turn it back on.
      enable_thinking: enableThinking,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      // Cap generated tokens so a long reasoning pass can't starve the answer;
      // omitted when unset so the server keeps its own default.
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      // Many local runtimes honor this; harmless when ignored because the
      // prompt also demands JSON explicitly wherever json=true is used.
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };

    async function requestMessage() {
      const res = postJson
        ? await postJson(url, payload, timeoutMs)
        : await fetchPost(url, payload, timeoutMs, apiKey);
      return res.choices?.[0]?.message ?? {};
    }

    if (json) {
      // Retry once on empty OR unparseable output: a thinking model can emit
      // only reasoning (empty content) or get its JSON truncated by the token
      // cap. parseJsonLoose strips residual <think> and tolerates fences.
      try { return parseJsonLoose((await requestMessage()).content ?? ''); }
      catch (e) { return parseJsonLoose((await requestMessage()).content ?? ''); }
    }

    // Work path. Thinking models (Qwen-style) sometimes emit only a
    // <think> block in `content`, or route the visible answer into a
    // `reasoning_content` field: strip think tags, and salvage reasoning
    // if content is then empty. Retry once on an empty completion — a thing
    // quantized thinking models do intermittently (all budget spent reasoning).
    const extract = (m) => stripThink(m.content ?? '') || stripThink(m.reasoning_content ?? '');
    let text = extract(await requestMessage());
    if (!text.trim()) text = extract(await requestMessage());
    return text;
  }

  return { chat };
}

async function fetchPost(url, payload, timeoutMs, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`llm: ${res.status} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Strip Qwen-style reasoning so it never leaks into an answer or breaks JSON
// parsing. Handles balanced <think>...</think> plus stray open/close tags.
function stripThink(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

// Tolerates model output wrapped in prose, code fences, or thinking blocks
// (Qwen-style <think>...</think> gets stripped before extraction).
function parseJsonLoose(text) {
  let t = stripThink(text)
    .replace(/```(?:json)?/g, '')
    .trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* fall through */ } }
  throw new Error(`llm: expected JSON, got: ${String(text).slice(0, 200)}`);
}

module.exports = { makeLlm };
