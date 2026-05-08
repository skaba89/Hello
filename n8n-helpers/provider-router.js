/**
 * n8n-helpers/provider-router.js
 * ══════════════════════════════════════════════════════════════════
 * Routeur multi-provider AI avec failover automatique.
 *
 * Providers supportés :
 *   claude     → Anthropic  /v1/messages          (format natif)
 *   groq       → Groq       /openai/v1/chat/…     (OpenAI-compat)
 *   openrouter → OpenRouter /api/v1/chat/…         (OpenAI-compat)
 *   gemini     → Google     /v1beta/models/…       (format Gemini)
 *   glm        → ZhipuAI   /api/paas/v4/chat/…    (OpenAI-compat)
 *
 * Usage Node.js :
 *   const { callAI } = require('./provider-router');
 *   const result = await callAI({ systemPrompt: '...', userPrompt: '...' });
 *   // result = { text, provider_used, model_used, tokens, _failover_errors }
 *
 * Variables d'env requises (selon providers activés) :
 *   AI_PROVIDER_ORDER=claude,groq,openrouter,gemini,glm
 *   CLAUDE_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY,
 *   GEMINI_API_KEY, GLM_API_KEY
 * ══════════════════════════════════════════════════════════════════
 */

require('dotenv').config();

// ── Config des providers ───────────────────────────────────────────

const PROVIDER_CONFIG = {
  claude: {
    name:         'Claude (Anthropic)',
    endpoint:     'https://api.anthropic.com/v1/messages',
    envKey:       'CLAUDE_API_KEY',
    modelEnvKey:  'CLAUDE_MODEL',
    defaultModel: 'claude-haiku-4-5-20251001',
    format:       'anthropic'
  },
  groq: {
    name:         'Groq',
    endpoint:     'https://api.groq.com/openai/v1/chat/completions',
    envKey:       'GROQ_API_KEY',
    modelEnvKey:  'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
    format:       'openai'
  },
  openrouter: {
    name:         'OpenRouter',
    endpoint:     'https://openrouter.ai/api/v1/chat/completions',
    envKey:       'OPENROUTER_API_KEY',
    modelEnvKey:  'OPENROUTER_MODEL',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    format:       'openai',
    extraHeaders: { 'HTTP-Referer': 'https://autoreach.local', 'X-Title': 'AutoReach' }
  },
  gemini: {
    name:         'Gemini Flash 2',
    endpoint:     'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    envKey:       'GEMINI_API_KEY',
    modelEnvKey:  'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
    format:       'gemini'
  },
  glm: {
    name:         'GLM-4 (ZhipuAI)',
    endpoint:     'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    envKey:       'GLM_API_KEY',
    modelEnvKey:  'GLM_MODEL',
    defaultModel: 'glm-4-flash',
    format:       'openai'
  }
};

// ── Construction de la requête ─────────────────────────────────────

function buildRequest(provider, config, { systemPrompt, userPrompt, maxTokens, modelOverride }) {
  const apiKey = process.env[config.envKey];
  if (!apiKey || apiKey.includes('CHANGE_ME')) {
    throw new Error(`Missing or unconfigured env var: ${config.envKey}`);
  }
  const model = modelOverride || process.env[config.modelEnvKey] || config.defaultModel;

  if (config.format === 'anthropic') {
    return {
      url: config.endpoint,
      headers: {
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
        'anthropic-beta':     'prompt-caching-2024-07-31'
      },
      body: {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt }]
      }
    };
  }

  if (config.format === 'openai') {
    return {
      url: config.endpoint,
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'content-type':   'application/json',
        ...(config.extraHeaders || {})
      },
      body: {
        model,
        max_tokens: maxTokens,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ]
      }
    };
  }

  if (config.format === 'gemini') {
    return {
      url: `${config.endpoint}?key=${apiKey}`,
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature:     0.7
        }
      }
    };
  }

  throw new Error(`Unknown provider format: ${config.format}`);
}

// ── Normalisation des réponses ─────────────────────────────────────

function normalizeResponse(provider, config, raw) {
  if (config.format === 'anthropic') {
    return {
      text:          raw?.content?.[0]?.text || '',
      provider_used: provider,
      model_used:    raw?.model || config.defaultModel,
      tokens: {
        input:  raw?.usage?.input_tokens  || 0,
        output: raw?.usage?.output_tokens || 0
      }
    };
  }

  if (config.format === 'openai') {
    return {
      text:          raw?.choices?.[0]?.message?.content || '',
      provider_used: provider,
      model_used:    raw?.model || config.defaultModel,
      tokens: {
        input:  raw?.usage?.prompt_tokens     || 0,
        output: raw?.usage?.completion_tokens || 0
      }
    };
  }

  if (config.format === 'gemini') {
    return {
      text:          raw?.candidates?.[0]?.content?.parts?.[0]?.text || '',
      provider_used: provider,
      model_used:    config.defaultModel,
      tokens: {
        input:  raw?.usageMetadata?.promptTokenCount     || 0,
        output: raw?.usageMetadata?.candidatesTokenCount || 0
      }
    };
  }

  throw new Error(`Unknown format for normalization: ${config.format}`);
}

// ── Routeur principal ──────────────────────────────────────────────

/**
 * Essaie les providers dans l'ordre et retourne la première réponse réussie.
 *
 * @param {object}   opts
 * @param {string}   opts.systemPrompt   - Prompt système (instructions)
 * @param {string}   opts.userPrompt     - Prompt utilisateur (input)
 * @param {number}  [opts.maxTokens=1024]
 * @param {string}  [opts.modelOverride] - Force un modèle spécifique
 * @param {string[]}[opts.providerOrder] - Surcharge AI_PROVIDER_ORDER
 * @param {number}  [opts.timeoutMs=30000]
 * @returns {Promise<{text, provider_used, model_used, tokens, _failover_errors}>}
 */
async function callAI({ systemPrompt, userPrompt, maxTokens = 1024, modelOverride, providerOrder, timeoutMs = 30000 } = {}) {
  const order = providerOrder
    || (process.env.AI_PROVIDER_ORDER || 'claude').split(',').map(p => p.trim()).filter(Boolean);

  const failoverErrors = [];

  for (const provider of order) {
    const config = PROVIDER_CONFIG[provider];
    if (!config) {
      failoverErrors.push(`${provider}: unknown provider`);
      continue;
    }

    const apiKey = process.env[config.envKey];
    if (!apiKey || apiKey.includes('CHANGE_ME')) {
      failoverErrors.push(`${provider}: API key not configured`);
      continue;
    }

    const t0 = Date.now();
    try {
      console.log(`[PROVIDER] Trying ${config.name}...`);
      const { url, headers, body } = buildRequest(provider, config, { systemPrompt, userPrompt, maxTokens, modelOverride });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, {
          method:  'POST',
          headers,
          body:    JSON.stringify(body),
          signal:  controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} — ${errBody.substring(0, 300)}`);
      }

      const data       = await response.json();
      const normalized = normalizeResponse(provider, config, data);
      const latencyMs  = Date.now() - t0;

      console.log(
        `[PROVIDER] ✅ ${config.name} | ` +
        `${normalized.tokens.input}→${normalized.tokens.output} tokens | ${latencyMs}ms`
      );

      return {
        ...normalized,
        latency_ms:       latencyMs,
        _failover_errors: failoverErrors.length ? failoverErrors : null
      };

    } catch (err) {
      const msg = err.name === 'AbortError'
        ? `${provider}: timeout after ${timeoutMs}ms`
        : `${provider}: ${err.message}`;
      console.error(`[PROVIDER] ❌ ${msg}`);
      failoverErrors.push(msg);
    }
  }

  throw new Error(
    `[PROVIDER] All providers failed:\n${failoverErrors.map(e => `  • ${e}`).join('\n')}`
  );
}

// ── Ping (health check) ────────────────────────────────────────────

/**
 * Envoie un prompt minimal à chaque provider et retourne leur latence.
 * Utile pour WF11 (monitoring de santé).
 */
async function pingAllProviders(order) {
  const providers = order
    || (process.env.AI_PROVIDER_ORDER || 'claude,groq,openrouter,gemini,glm')
       .split(',').map(p => p.trim());

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const config = PROVIDER_CONFIG[provider];
      if (!config) return { provider, status: 'unknown', latency_ms: null };

      const apiKey = process.env[config.envKey];
      if (!apiKey || apiKey.includes('CHANGE_ME')) {
        return { provider, status: 'no_key', latency_ms: null };
      }

      const t0 = Date.now();
      try {
        const result = await callAI({
          systemPrompt: 'Reply with a single word.',
          userPrompt:   'Ping',
          maxTokens:    10,
          providerOrder: [provider],
          timeoutMs:    15000
        });
        return {
          provider,
          status:     'healthy',
          latency_ms: Date.now() - t0,
          model_used: result.model_used
        };
      } catch (err) {
        return {
          provider,
          status:     'error',
          latency_ms: Date.now() - t0,
          error:      err.message.substring(0, 200)
        };
      }
    })
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { provider: providers[i], status: 'error', latency_ms: null, error: r.reason?.message }
  );
}

module.exports = { callAI, pingAllProviders, PROVIDER_CONFIG, buildRequest, normalizeResponse };
