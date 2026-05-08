-- ════════════════════════════════════════════════════════════════
-- Migration 003 — Statistiques Multi-Provider AI
-- Suivi des appels, latences et failovers par provider.
-- ════════════════════════════════════════════════════════════════

-- ── Table principale ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_provider_stats (
  id               SERIAL PRIMARY KEY,
  provider         VARCHAR(50)  NOT NULL,                          -- claude|groq|openrouter|gemini|glm
  provider_name    VARCHAR(100),
  call_type        VARCHAR(100),                                   -- outreach_gen|qualification|learning…
  status           VARCHAR(20)  NOT NULL CHECK (status IN ('success','error','timeout')),
  model_used       VARCHAR(100),
  latency_ms       INTEGER,
  tokens_input     INTEGER      DEFAULT 0,
  tokens_output    INTEGER      DEFAULT 0,
  cost_eur         NUMERIC(10,6) DEFAULT 0,
  error_message    TEXT,
  was_failover     BOOLEAN      DEFAULT FALSE,
  failover_from    TEXT[],                                         -- providers essayés avant celui-ci
  prospect_id      INTEGER      REFERENCES prospects(id) ON DELETE SET NULL,
  recorded_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_stats_provider
  ON ai_provider_stats(provider, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_provider_stats_status
  ON ai_provider_stats(status, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_provider_stats_date
  ON ai_provider_stats(recorded_at DESC);

-- ── Vue : santé par provider (1h glissante) ────────────────────
CREATE OR REPLACE VIEW v_provider_health AS
SELECT
  provider,
  provider_name,
  COUNT(*) FILTER (WHERE recorded_at >= NOW() - INTERVAL '1 hour')          AS calls_1h,
  COUNT(*) FILTER (WHERE status = 'success' AND recorded_at >= NOW() - INTERVAL '1 hour') AS success_1h,
  COUNT(*) FILTER (WHERE status = 'error'   AND recorded_at >= NOW() - INTERVAL '1 hour') AS errors_1h,
  COUNT(*) FILTER (WHERE status = 'timeout' AND recorded_at >= NOW() - INTERVAL '1 hour') AS timeouts_1h,
  ROUND(
    AVG(latency_ms) FILTER (WHERE status = 'success' AND recorded_at >= NOW() - INTERVAL '1 hour')
  )::INTEGER                                                                 AS avg_latency_ms,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'success' AND recorded_at >= NOW() - INTERVAL '1 hour')
    / NULLIF(COUNT(*) FILTER (WHERE recorded_at >= NOW() - INTERVAL '1 hour'), 0), 1
  )                                                                          AS success_rate_pct,
  SUM(tokens_input)  FILTER (WHERE recorded_at >= CURRENT_DATE)             AS tokens_in_today,
  SUM(tokens_output) FILTER (WHERE recorded_at >= CURRENT_DATE)             AS tokens_out_today,
  SUM(cost_eur)      FILTER (WHERE recorded_at >= CURRENT_DATE)             AS cost_eur_today,
  MAX(recorded_at)   FILTER (WHERE status = 'success')                      AS last_success_at,
  MAX(recorded_at)   FILTER (WHERE status IN ('error','timeout'))            AS last_error_at
FROM ai_provider_stats
GROUP BY provider, provider_name;

-- ── Vue : tableau de bord failover (24h) ──────────────────────
CREATE OR REPLACE VIEW v_failover_stats AS
SELECT
  DATE_TRUNC('hour', recorded_at)   AS hour,
  provider,
  COUNT(*)                           AS total_calls,
  COUNT(*) FILTER (WHERE was_failover)  AS failover_calls,
  ROUND(100.0 * COUNT(*) FILTER (WHERE was_failover) / NULLIF(COUNT(*),0), 1) AS failover_rate_pct,
  ROUND(AVG(latency_ms) FILTER (WHERE status='success'))::INT AS avg_latency_ms
FROM ai_provider_stats
WHERE recorded_at >= NOW() - INTERVAL '24 hours'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ── Config initiale des providers ─────────────────────────────
INSERT INTO system_config (key, value, description) VALUES
  ('ai_provider_order',         'claude,groq,openrouter,gemini,glm', 'Ordre de failover des providers AI'),
  ('ai_provider_primary',       'claude',                            'Provider principal actif'),
  ('ai_failover_enabled',       'true',                              'Activer le failover automatique'),
  ('ai_provider_timeout_ms',    '30000',                             'Timeout par requête AI (ms)'),
  ('ai_provider_max_retries',   '1',                                 'Tentatives par provider avant failover')
ON CONFLICT (key) DO NOTHING;
