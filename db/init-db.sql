-- ══════════════════════════════════════════════════════════════════
-- init-db.sql – Schéma complet de la base de données automation
-- PostgreSQL 14+
-- ══════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Pour la recherche full-text

-- ─────────────────────────────────────────────
-- Table : prospects
-- Contacts cibles à démarcher
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospects (
    id                  BIGSERIAL PRIMARY KEY,
    uuid                UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,

    -- Informations de base
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100),
    full_name           VARCHAR(200) GENERATED ALWAYS AS (first_name || ' ' || COALESCE(last_name, '')) STORED,
    email               VARCHAR(255),
    phone               VARCHAR(50),

    -- LinkedIn
    linkedin_url        VARCHAR(500) UNIQUE,
    linkedin_id         VARCHAR(100),

    -- Instagram
    instagram_username  VARCHAR(100) UNIQUE,
    instagram_url       VARCHAR(500),

    -- Entreprise
    company             VARCHAR(255),
    title               VARCHAR(255),
    industry            VARCHAR(100),
    company_size        VARCHAR(50),     -- startup, sme, midmarket, enterprise
    location            VARCHAR(100),

    -- Qualification
    profile_score       INTEGER DEFAULT 0 CHECK (profile_score BETWEEN 0 AND 10),
    icp_match           BOOLEAN DEFAULT FALSE,
    decision_maker      BOOLEAN DEFAULT FALSE,
    likely_pain_points  TEXT[],
    public_fact         TEXT,           -- Fait spécifique utilisable dans un message
    best_angle          TEXT,           -- Angle d'approche recommandé par Claude

    -- Statut dans le pipeline
    platform            VARCHAR(20) NOT NULL DEFAULT 'linkedin' CHECK (platform IN ('linkedin', 'instagram', 'both')),
    status              VARCHAR(50) NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new', 'qualifying', 'contacted', 'connected', 'engaged', 'hot_lead', 'converted', 'cold', 'unsubscribed', 'do_not_contact')),

    -- Source
    source              VARCHAR(100),   -- csv_import, manual, scraper, webhook
    source_campaign     VARCHAR(100),

    -- Métadonnées
    raw_profile_data    JSONB,
    tags                TEXT[],
    notes               TEXT,

    -- Timestamps
    created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_contacted_at   TIMESTAMPTZ,
    converted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_platform ON prospects(platform);
CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(profile_score DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_company ON prospects(company);
CREATE INDEX IF NOT EXISTS idx_prospects_created_at ON prospects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_tags ON prospects USING gin(tags);

-- ─────────────────────────────────────────────
-- Table : actions
-- Journal de toutes les actions effectuées
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actions (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,

    prospect_id     BIGINT REFERENCES prospects(id) ON DELETE SET NULL,
    platform        VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'instagram')),
    action_type     VARCHAR(50) NOT NULL
                    CHECK (action_type IN (
                        'invite_sent', 'invite_accepted', 'invite_failed',
                        'message_sent', 'message_failed',
                        'dm_received', 'dm_replied',
                        'profile_viewed', 'content_liked',
                        'sequence_started', 'sequence_completed', 'sequence_stopped'
                    )),

    -- Résultat
    status          VARCHAR(20) NOT NULL DEFAULT 'success'
                    CHECK (status IN ('success', 'error', 'pending', 'skipped')),
    error_message   TEXT,
    error_code      VARCHAR(50),

    -- Contenu de l'action
    payload         JSONB DEFAULT '{}',     -- Message envoyé, URL, etc.
    response_data   JSONB DEFAULT '{}',     -- Réponse du serveur Playwright

    -- Contexte
    workflow_id     VARCHAR(100),
    execution_id    VARCHAR(100),
    dry_run         BOOLEAN DEFAULT FALSE,

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    executed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actions_prospect_id ON actions(prospect_id);
CREATE INDEX IF NOT EXISTS idx_actions_platform ON actions(platform);
CREATE INDEX IF NOT EXISTS idx_actions_action_type ON actions(action_type);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_created_at ON actions(created_at DESC);

-- ─────────────────────────────────────────────
-- Table : conversations
-- Suivi des échanges avec les prospects
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
    id                  BIGSERIAL PRIMARY KEY,
    prospect_id         BIGINT REFERENCES prospects(id) ON DELETE SET NULL,

    platform            VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'instagram')),
    conversation_url    VARCHAR(500) UNIQUE,

    -- Analyse Claude du dernier message
    last_message        TEXT,
    last_message_at     TIMESTAMPTZ,
    last_replied_at     TIMESTAMPTZ,

    -- Qualification conversation
    score               INTEGER DEFAULT 0 CHECK (score BETWEEN 0 AND 10),
    intent              VARCHAR(50)
                        CHECK (intent IN ('interest', 'question', 'rejection', 'neutral', 'hot_lead', 'complaint', 'out_of_scope')),
    urgency             VARCHAR(20) CHECK (urgency IN ('high', 'medium', 'low')),
    key_insights        TEXT[],

    -- Statut
    status              VARCHAR(50) DEFAULT 'active'
                        CHECK (status IN ('active', 'replied', 'escalated', 'closed', 'ignored')),
    requires_human      BOOLEAN DEFAULT FALSE,
    human_assigned_to   VARCHAR(100),

    -- Full conversation history (JSONB array of messages)
    message_history     JSONB DEFAULT '[]',
    reply_count         INTEGER DEFAULT 0,

    created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_prospect_id ON conversations(prospect_id);
CREATE INDEX IF NOT EXISTS idx_conversations_score ON conversations(score DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_requires_human ON conversations(requires_human) WHERE requires_human = TRUE;
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

-- ─────────────────────────────────────────────
-- Table : sequence_steps
-- Étapes planifiées des séquences d'outreach
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sequence_steps (
    id              BIGSERIAL PRIMARY KEY,
    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,

    -- Définition de l'étape
    step_number     INTEGER NOT NULL CHECK (step_number > 0),
    step_type       VARCHAR(50) NOT NULL
                    CHECK (step_type IN ('invite', 'message', 'follow_up_1', 'follow_up_2', 'content_like', 'profile_view')),
    template_key    VARCHAR(100),

    -- Planification
    scheduled_at    TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'skipped', 'failed', 'cancelled')),

    -- Résultat
    sent_at         TIMESTAMPTZ,
    message_sent    TEXT,
    error_message   TEXT,

    -- Contrainte unique : une seule étape par prospect par numéro
    UNIQUE(prospect_id, step_number),

    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seq_steps_status ON sequence_steps(status);
CREATE INDEX IF NOT EXISTS idx_seq_steps_scheduled ON sequence_steps(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_seq_steps_prospect ON sequence_steps(prospect_id);

-- ─────────────────────────────────────────────
-- Table : quotas
-- Suivi des limites d'actions par jour/semaine
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotas (
    id              BIGSERIAL PRIMARY KEY,
    platform        VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'instagram')),
    action_type     VARCHAR(50) NOT NULL,
    quota_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    count           INTEGER DEFAULT 0 NOT NULL,
    limit_value     INTEGER NOT NULL,
    reset_at        TIMESTAMPTZ,

    UNIQUE(platform, action_type, quota_date),

    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Valeurs par défaut
INSERT INTO quotas (platform, action_type, quota_date, count, limit_value)
VALUES
    ('linkedin', 'invite', CURRENT_DATE, 0, 60),
    ('linkedin', 'message', CURRENT_DATE, 0, 100),
    ('instagram', 'dm', CURRENT_DATE, 0, 30)
ON CONFLICT (platform, action_type, quota_date) DO NOTHING;

-- ─────────────────────────────────────────────
-- Table : content_calendar
-- Calendrier éditorial
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_calendar (
    id              BIGSERIAL PRIMARY KEY,
    topic           TEXT NOT NULL,
    target_audience TEXT,
    tone            VARCHAR(50) DEFAULT 'professional',
    keywords        TEXT[],
    platform        VARCHAR(20) DEFAULT 'both' CHECK (platform IN ('linkedin', 'instagram', 'both')),
    goal            VARCHAR(100),
    angle           TEXT,
    scheduled_date  DATE NOT NULL,
    priority        INTEGER DEFAULT 5,
    status          VARCHAR(20) DEFAULT 'planned' CHECK (status IN ('planned', 'generated', 'approved', 'rejected', 'published')),

    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_calendar_date ON content_calendar(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_content_calendar_status ON content_calendar(status);

-- ─────────────────────────────────────────────
-- Table : content_posts
-- Posts générés prêts à publier
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_posts (
    id              BIGSERIAL PRIMARY KEY,
    calendar_id     BIGINT REFERENCES content_calendar(id),
    topic           TEXT,
    platform        VARCHAR(20) NOT NULL CHECK (platform IN ('linkedin', 'instagram')),
    content         TEXT NOT NULL,
    hashtags        TEXT[],
    status          VARCHAR(30) DEFAULT 'pending_review'
                    CHECK (status IN ('pending_review', 'approved', 'rejected', 'published', 'archived')),
    review_notes    TEXT,
    scheduled_date  DATE,
    published_at    TIMESTAMPTZ,

    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ─────────────────────────────────────────────
-- Table : monitoring_logs
-- Historique des rapports de monitoring
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitoring_logs (
    id          BIGSERIAL PRIMARY KEY,
    severity    VARCHAR(20) NOT NULL CHECK (severity IN ('ok', 'warning', 'critical')),
    metrics     JSONB NOT NULL,
    alerts      JSONB DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monitoring_severity ON monitoring_logs(severity);
CREATE INDEX IF NOT EXISTS idx_monitoring_created_at ON monitoring_logs(created_at DESC);

-- ─────────────────────────────────────────────
-- Table : system_config
-- Configuration dynamique du système
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Valeurs par défaut
INSERT INTO system_config (key, value, description) VALUES
    ('outreach_mode', 'active', 'active | sleeping | paused'),
    ('linkedin_daily_limit', '60', 'Nombre max d''invitations LinkedIn par jour'),
    ('instagram_daily_limit', '30', 'Nombre max de DMs Instagram par jour'),
    ('dry_run', 'false', 'Mode simulation (ne pas envoyer réellement)'),
    ('auto_reply_enabled', 'true', 'Activer les réponses automatiques aux DMs'),
    ('min_score_for_outreach', '6', 'Score minimum pour déclencher l''outreach')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────
-- Triggers – updated_at automatique
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prospects_updated_at
    BEFORE UPDATE ON prospects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_actions_updated_at
    BEFORE UPDATE ON actions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_sequence_steps_updated_at
    BEFORE UPDATE ON sequence_steps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_quotas_updated_at
    BEFORE UPDATE ON quotas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────
-- Vues utiles
-- ─────────────────────────────────────────────

-- Vue : pipeline commercial
CREATE OR REPLACE VIEW v_pipeline AS
SELECT
    p.id,
    p.full_name,
    p.company,
    p.title,
    p.platform,
    p.status,
    p.profile_score,
    COUNT(DISTINCT a.id) as action_count,
    MAX(a.created_at) as last_action_at,
    c.score as conversation_score,
    c.intent,
    c.requires_human
FROM prospects p
LEFT JOIN actions a ON a.prospect_id = p.id
LEFT JOIN conversations c ON c.prospect_id = p.id
WHERE p.status NOT IN ('unsubscribed', 'do_not_contact')
GROUP BY p.id, p.full_name, p.company, p.title, p.platform, p.status, p.profile_score, c.score, c.intent, c.requires_human
ORDER BY c.score DESC NULLS LAST, p.profile_score DESC;

-- Vue : métriques quotidiennes
CREATE OR REPLACE VIEW v_daily_metrics AS
SELECT
    DATE(created_at) as date,
    platform,
    action_type,
    status,
    COUNT(*) as count
FROM actions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at), platform, action_type, status
ORDER BY date DESC;

-- Vue : prospects chauds nécessitant attention humaine
CREATE OR REPLACE VIEW v_hot_leads AS
SELECT
    p.full_name,
    p.company,
    p.title,
    p.platform,
    c.score,
    c.intent,
    c.urgency,
    c.last_message,
    c.last_message_at,
    c.conversation_url
FROM conversations c
JOIN prospects p ON p.id = c.prospect_id
WHERE c.requires_human = TRUE
   OR c.score >= 8
ORDER BY c.score DESC, c.last_message_at DESC;

-- ─────────────────────────────────────────────
-- Données de test (commenter en production)
-- ─────────────────────────────────────────────
/*
INSERT INTO prospects (first_name, last_name, company, title, linkedin_url, platform, profile_score, icp_match, public_fact)
VALUES
    ('Marie', 'Dupont', 'TechCorp', 'CTO', 'https://linkedin.com/in/marie-dupont-test', 'linkedin', 8, true, 'A récemment publié sur la transformation digitale de TechCorp'),
    ('Jean', 'Martin', 'StartupXYZ', 'CEO', 'https://linkedin.com/in/jean-martin-test', 'linkedin', 7, true, 'Vient de lever 2M€ en série A'),
    ('Sophie', 'Bernard', 'AgenceABC', 'Marketing Director', 'https://linkedin.com/in/sophie-bernard-test', 'linkedin', 6, true, 'Anime une communauté LinkedIn de 5000 membres sur le marketing B2B');

INSERT INTO content_calendar (topic, target_audience, tone, keywords, scheduled_date, status) VALUES
    ('Les 3 erreurs que font 90% des équipes sales sur LinkedIn', 'Directeurs commerciaux PME', 'expert_but_accessible', ARRAY['linkedin', 'prospection', 'sales', 'B2B'], CURRENT_DATE + 2, 'planned'),
    ('Comment nous avons multiplié par 3 notre taux de réponse en 30 jours', 'Head of Sales, VP Sales', 'storytelling', ARRAY['outreach', 'cold_messaging', 'growth'], CURRENT_DATE + 5, 'planned');
*/

-- ─────────────────────────────────────────────
-- Index de performance supplémentaires
-- ─────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_actions_daily
    ON actions(DATE(created_at), platform, action_type, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospects_full_name_trgm
    ON prospects USING gin(full_name gin_trgm_ops);

-- Permissions (ajuster selon votre config)
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO automation;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO automation;
