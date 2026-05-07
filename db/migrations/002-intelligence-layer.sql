-- ══════════════════════════════════════════════════════════════════
-- migrations/002-intelligence-layer.sql
-- Signaux prospects, attribution revenue, bot Telegram, shadow ban
-- Appliquer APRÈS 001-learning-features.sql
-- ══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- Table : prospect_signals
-- Événements détectés sur les profils (job change, funding, post…).
-- Chaque signal peut déclencher une relance personnalisée.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospect_signals (
    id              BIGSERIAL PRIMARY KEY,

    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    detected_at     TIMESTAMPTZ DEFAULT NOW(),

    -- Type de signal
    signal_type     VARCHAR(60) NOT NULL
                    CHECK (signal_type IN (
                        'job_change',          -- Nouveau poste
                        'company_funding',     -- Levée de fonds
                        'viral_post',          -- Publication LinkedIn virale (>500 likes)
                        'company_expansion',   -- Expansion géographique / recrutement massif
                        'award_or_recognition',-- Prix, certification, B Corp…
                        'product_launch',      -- Nouveau produit annoncé
                        'competitor_mention',  -- Mentionne un concurrent
                        'pain_point_signal',   -- Exprime un pain point public
                        'buying_signal',       -- Signal d'achat (cherche un outil, pose une question)
                        'reactivation'         -- Prospect froid qui redevient actif
                    )),
    signal_strength VARCHAR(20) DEFAULT 'medium'
                    CHECK (signal_strength IN ('low','medium','high','critical')),

    -- Détails du signal
    signal_source   VARCHAR(100),  -- linkedin_post, news_article, company_update
    signal_url      TEXT,          -- URL de la source
    signal_title    TEXT,          -- Titre de l'article / post
    signal_excerpt  TEXT,          -- Extrait pertinent (max 500 chars)
    signal_date     DATE,          -- Date de l'événement (pas détection)

    -- Score delta (combien ce signal fait monter le score)
    score_delta     INTEGER DEFAULT 0,  -- +1 à +5

    -- Action déclenchée
    triggered_action  BOOLEAN DEFAULT FALSE,
    action_id         BIGINT REFERENCES actions(id),
    action_scheduled_at TIMESTAMPTZ,

    -- Message généré par Claude pour ce signal
    generated_message TEXT,

    -- Méta
    processed        BOOLEAN DEFAULT FALSE,
    notes            TEXT
);

CREATE INDEX idx_signals_prospect ON prospect_signals(prospect_id, detected_at DESC);
CREATE INDEX idx_signals_type ON prospect_signals(signal_type, signal_strength);
CREATE INDEX idx_signals_unprocessed ON prospect_signals(processed) WHERE processed = FALSE;

-- ─────────────────────────────────────────────────────────────────
-- Table : revenue_attribution
-- Suivi des meetings, deals et revenus générés par l'automation.
-- Permet de calculer le ROI réel (coût Claude + infra vs revenus).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_attribution (
    id              BIGSERIAL PRIMARY KEY,

    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

    -- Funnel
    stage           VARCHAR(50) NOT NULL
                    CHECK (stage IN ('meeting_booked','meeting_done','proposal_sent','deal_won','deal_lost','recurring')),
    stage_date      DATE NOT NULL DEFAULT CURRENT_DATE,

    -- Valeur
    deal_value_eur  NUMERIC(12,2) DEFAULT 0,    -- Valeur du deal en €
    mrr_eur         NUMERIC(10,2) DEFAULT 0,    -- MRR si récurrent
    is_recurring    BOOLEAN DEFAULT FALSE,

    -- Attribution
    first_touch     VARCHAR(50),    -- Canal du premier contact (linkedin, instagram)
    touchpoints     INTEGER DEFAULT 1,  -- Nombre de messages avant conversion
    days_to_convert INTEGER,            -- Jours entre premier contact et signature

    -- Coûts associés (remplis par Workflow 5/monitoring)
    claude_cost_eur NUMERIC(8,4) DEFAULT 0,  -- Coût Claude pour ce prospect
    infra_cost_eur  NUMERIC(8,4) DEFAULT 0,  -- Part pro-rata infra (Docker, VPS…)

    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_revenue_prospect ON revenue_attribution(prospect_id);
CREATE INDEX idx_revenue_stage ON revenue_attribution(stage, stage_date DESC);

-- ─────────────────────────────────────────────────────────────────
-- Table : platform_health
-- Suivi de la santé des plateformes pour shadow ban detection.
-- Enregistre un snapshot toutes les heures.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_health (
    id              BIGSERIAL PRIMARY KEY,
    platform        VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin','instagram')),
    recorded_at     TIMESTAMPTZ DEFAULT NOW(),

    -- Métriques de santé
    invites_sent_24h    INTEGER DEFAULT 0,
    accepts_received_24h INTEGER DEFAULT 0,
    acceptance_rate_pct NUMERIC(5,2),      -- accepts / invites * 100
    replies_received_24h INTEGER DEFAULT 0,
    reply_rate_pct      NUMERIC(5,2),

    -- Signaux d'alerte
    rate_drop_flag      BOOLEAN DEFAULT FALSE,  -- Chute ≥30% vs moyenne 7j
    consecutive_errors  INTEGER DEFAULT 0,
    last_captcha_at     TIMESTAMPTZ,
    last_error_type     VARCHAR(100),

    -- Score de santé composite 0-100
    health_score        INTEGER DEFAULT 100,
    health_status       VARCHAR(20) DEFAULT 'healthy'
                        CHECK (health_status IN ('healthy','warning','degraded','paused','banned')),

    -- Action prise
    auto_action_taken   VARCHAR(100),  -- 'none' | 'rate_reduced' | 'paused' | 'alerted'
    paused_until        TIMESTAMPTZ
);

CREATE INDEX idx_platform_health_platform ON platform_health(platform, recorded_at DESC);
CREATE INDEX idx_platform_health_status ON platform_health(health_status) WHERE health_status != 'healthy';

-- ─────────────────────────────────────────────────────────────────
-- Table : cold_recycling
-- Prospects froids programmés pour réactivation après délai.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cold_recycling (
    id              BIGSERIAL PRIMARY KEY,

    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE UNIQUE,

    -- Programmation
    recycled_at     TIMESTAMPTZ DEFAULT NOW(),
    scheduled_for   TIMESTAMPTZ NOT NULL,    -- Date de relance prévue
    reason_for_cold TEXT,                    -- Pourquoi il était froid

    -- Re-qualification
    new_score       INTEGER,                 -- Score Claude re-calculé
    new_angle       TEXT,                    -- Nouvel angle d'approche
    new_public_fact TEXT,                    -- Nouveau fait public trouvé
    recycling_prompt TEXT,                   -- Prompt Claude pour ce prospect

    -- Statut
    status          VARCHAR(30) DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','sent','replied','re_converted','abandoned')),
    sent_at         TIMESTAMPTZ,
    result_notes    TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recycling_scheduled ON cold_recycling(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX idx_recycling_status ON cold_recycling(status);

-- ─────────────────────────────────────────────────────────────────
-- Table : telegram_notifications
-- Log des notifications envoyées via le bot Telegram.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_notifications (
    id              BIGSERIAL PRIMARY KEY,

    -- Contenu
    notification_type VARCHAR(60) NOT NULL
                    CHECK (notification_type IN (
                        'hot_lead','daily_summary','weekly_report',
                        'shadow_ban_alert','error_critical',
                        'ab_test_result','learning_report',
                        'meeting_booked','crm_export'
                    )),
    message_text    TEXT NOT NULL,
    chat_id         VARCHAR(50),
    message_id      VARCHAR(50),  -- ID Telegram du message envoyé

    -- Boutons interactifs (inline keyboard)
    has_buttons     BOOLEAN DEFAULT FALSE,
    buttons_json    JSONB,        -- [{text, callback_data}]

    -- Réponse utilisateur
    user_response   VARCHAR(100),  -- callback_data reçu
    responded_at    TIMESTAMPTZ,

    -- Lien vers l'entité concernée
    prospect_id     BIGINT REFERENCES prospects(id),
    action_id       BIGINT REFERENCES actions(id),

    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    delivered       BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_telegram_type ON telegram_notifications(notification_type, sent_at DESC);
CREATE INDEX idx_telegram_unresponded ON telegram_notifications(has_buttons, responded_at) WHERE has_buttons = TRUE AND responded_at IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- Vue : v_roi_dashboard
-- Tableau de bord ROI en temps réel.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_roi_dashboard AS
WITH costs AS (
    SELECT
        COALESCE(SUM(CASE WHEN action_type IN ('invite','dm') THEN 0.008 ELSE 0.003 END), 0) AS total_claude_cost,
        COUNT(*) AS total_actions
    FROM actions
    WHERE created_at >= DATE_TRUNC('month', NOW())
),
revenue AS (
    SELECT
        COALESCE(SUM(deal_value_eur) FILTER (WHERE stage = 'deal_won'), 0)        AS deals_won_value,
        COALESCE(SUM(mrr_eur * 12) FILTER (WHERE stage = 'deal_won' AND is_recurring), 0) AS arr_value,
        COUNT(*) FILTER (WHERE stage = 'meeting_booked')                            AS meetings_booked,
        COUNT(*) FILTER (WHERE stage = 'deal_won')                                 AS deals_won,
        ROUND(AVG(days_to_convert) FILTER (WHERE stage = 'deal_won'), 0)          AS avg_days_to_close
    FROM revenue_attribution
    WHERE stage_date >= DATE_TRUNC('month', NOW())
)
SELECT
    c.total_actions,
    c.total_claude_cost,
    r.deals_won_value,
    r.arr_value,
    r.meetings_booked,
    r.deals_won,
    r.avg_days_to_close,
    CASE WHEN c.total_claude_cost > 0
         THEN ROUND(r.deals_won_value / c.total_claude_cost, 1)
         ELSE 0 END                                                  AS roi_multiplier,
    CASE WHEN r.meetings_booked > 0
         THEN ROUND(c.total_claude_cost / r.meetings_booked, 2)
         ELSE NULL END                                               AS cost_per_meeting_eur,
    CASE WHEN r.deals_won > 0
         THEN ROUND((c.total_claude_cost + 15) / r.deals_won, 2)   -- +15€ infra mensuelle
         ELSE NULL END                                               AS cac_eur
FROM costs c, revenue r;

-- ─────────────────────────────────────────────────────────────────
-- Vue : v_signals_feed
-- Feed des signaux récents non traités, triés par force.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_signals_feed AS
SELECT
    ps.id,
    ps.prospect_id,
    p.full_name,
    p.title,
    p.company,
    p.profile_score,
    p.status,
    ps.signal_type,
    ps.signal_strength,
    ps.signal_title,
    ps.signal_excerpt,
    ps.signal_date,
    ps.score_delta,
    ps.detected_at,
    ps.triggered_action
FROM prospect_signals ps
JOIN prospects p ON ps.prospect_id = p.id
WHERE ps.processed = FALSE
ORDER BY
    CASE ps.signal_strength WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    ps.detected_at DESC;

-- ─────────────────────────────────────────────────────────────────
-- Trigger updated_at
-- ─────────────────────────────────────────────────────────────────
CREATE TRIGGER trg_revenue_updated_at
    BEFORE UPDATE ON revenue_attribution
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────
-- Ajout colonnes sur prospects pour le recyclage et les signaux
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE prospects
    ADD COLUMN IF NOT EXISTS cold_since          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS signal_count        INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_signal_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revenue_stage       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS deal_value_eur      NUMERIC(12,2);

-- ─────────────────────────────────────────────────────────────────
-- Config système étendue pour Telegram et shadow ban thresholds
-- ─────────────────────────────────────────────────────────────────
INSERT INTO system_config (key, value, description) VALUES
  ('telegram_bot_token',      '""',    'Token du bot Telegram (BotFather)'),
  ('telegram_chat_id',        '""',    'Chat ID Telegram pour les notifications'),
  ('shadow_ban_threshold_pct','30',    'Chute % taux acceptation avant alerte shadow ban'),
  ('cold_recycling_days',     '90',    'Jours avant recyclage automatique prospect froid'),
  ('revenue_target_monthly',  '5000',  'Objectif CA mensuel en € pour le dashboard ROI'),
  ('signal_check_interval_h', '6',     'Fréquence vérification signaux en heures'),
  ('min_score_for_signal',    '5',     'Score minimum pour surveiller les signaux d''un prospect')
ON CONFLICT (key) DO NOTHING;
