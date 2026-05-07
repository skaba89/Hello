-- ══════════════════════════════════════════════════════════════════
-- migrations/001-learning-features.sql
-- Nouvelles tables : apprentissage, A/B tests, insights, CRM sync
-- Appliquer APRÈS init-db.sql
-- ══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- Table : message_templates
-- Templates versionnés avec métriques de performance.
-- Claude améliore automatiquement les templates qui sous-performent.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_templates (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,

    -- Identification
    template_type   VARCHAR(50) NOT NULL
                    CHECK (template_type IN ('outreach_linkedin','outreach_instagram','followup_j3','followup_j7','dm_reply','content_linkedin','content_instagram')),
    variant         VARCHAR(10) NOT NULL DEFAULT 'A',   -- A, B, C…
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_champion     BOOLEAN NOT NULL DEFAULT FALSE,     -- variant gagnante d'un A/B test

    -- Contenu du template
    system_prompt   TEXT NOT NULL,
    user_prompt     TEXT NOT NULL,
    model           VARCHAR(60) DEFAULT 'claude-opus-4-7',
    max_tokens      INTEGER DEFAULT 500,

    -- Métriques de performance (calculées par Workflow 6)
    sends_count         INTEGER DEFAULT 0,
    responses_count     INTEGER DEFAULT 0,
    positive_responses  INTEGER DEFAULT 0,
    conversions         INTEGER DEFAULT 0,   -- prospects devenus hot_lead ou converted
    response_rate       NUMERIC(5,2),        -- responses / sends * 100
    positive_rate       NUMERIC(5,2),        -- positive / responses * 100
    conversion_rate     NUMERIC(5,2),        -- conversions / sends * 100

    -- Génération
    generated_by        VARCHAR(50) DEFAULT 'human',   -- human | claude_learning | ab_winner
    parent_template_id  BIGINT REFERENCES message_templates(id),
    generation_context  JSONB,               -- contexte ayant mené à cette version

    -- Méta
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    retired_at      TIMESTAMPTZ
);

CREATE INDEX idx_templates_type_active ON message_templates(template_type, is_active);
CREATE INDEX idx_templates_champion ON message_templates(is_champion) WHERE is_champion = TRUE;

-- ─────────────────────────────────────────────────────────────────
-- Table : ab_tests
-- Suivi des tests A/B : quelle variante a reçu quel prospect.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ab_tests (
    id              BIGSERIAL PRIMARY KEY,

    -- Liens
    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    template_id     BIGINT NOT NULL REFERENCES message_templates(id),

    -- Contexte du test
    test_name       VARCHAR(100) NOT NULL,   -- ex: 'outreach_linkedin_oct2025'
    variant         VARCHAR(10) NOT NULL,     -- A ou B
    template_type   VARCHAR(50) NOT NULL,

    -- Action déclenchée
    action_id       BIGINT REFERENCES actions(id),
    sent_at         TIMESTAMPTZ DEFAULT NOW(),

    -- Résultat mesuré
    got_response    BOOLEAN DEFAULT FALSE,
    response_at     TIMESTAMPTZ,
    response_score  INTEGER,                 -- score de l'analyse Claude sur la réponse
    response_intent VARCHAR(50),
    converted       BOOLEAN DEFAULT FALSE,   -- est devenu hot_lead ou converted
    converted_at    TIMESTAMPTZ,

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ab_tests_prospect ON ab_tests(prospect_id);
CREATE INDEX idx_ab_tests_test_name ON ab_tests(test_name, variant);
CREATE INDEX idx_ab_tests_template ON ab_tests(template_id);

-- ─────────────────────────────────────────────────────────────────
-- Table : performance_insights
-- Insights hebdomadaires générés par Claude (Prompt F).
-- Historique de tout ce que le système a appris au fil du temps.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS performance_insights (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID DEFAULT uuid_generate_v4() UNIQUE NOT NULL,

    -- Période analysée
    week_start      DATE NOT NULL,
    week_end        DATE NOT NULL,
    generated_at    TIMESTAMPTZ DEFAULT NOW(),

    -- Métriques de la semaine (snapshot)
    total_outreach      INTEGER DEFAULT 0,
    total_responses     INTEGER DEFAULT 0,
    total_hot_leads     INTEGER DEFAULT 0,
    total_conversions   INTEGER DEFAULT 0,
    avg_response_rate   NUMERIC(5,2),
    avg_score_responses NUMERIC(4,2),

    -- Insights Claude (JSON structuré)
    insights            JSONB NOT NULL,
    -- Structure attendue :
    -- {
    --   "top_performing_segments": [...],
    --   "underperforming_segments": [...],
    --   "best_message_patterns": [...],
    --   "worst_message_patterns": [...],
    --   "recommended_icp_adjustments": "...",
    --   "template_improvements": [{type, current_rate, suggestion, new_prompt}],
    --   "timing_insights": "...",
    --   "platform_comparison": {...},
    --   "overall_health": "good|warning|critical",
    --   "executive_summary": "..."
    -- }

    -- Templates améliorés cette semaine
    templates_created   INTEGER DEFAULT 0,
    templates_retired   INTEGER DEFAULT 0,

    -- Rapport Discord envoyé
    discord_sent        BOOLEAN DEFAULT FALSE,
    discord_message_id  VARCHAR(100),

    UNIQUE(week_start)
);

CREATE INDEX idx_insights_week ON performance_insights(week_start DESC);

-- ─────────────────────────────────────────────────────────────────
-- Table : crm_sync
-- Suivi des exports vers CRM externe (HubSpot, Pipedrive, Notion…).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_sync (
    id              BIGSERIAL PRIMARY KEY,

    -- Liens
    prospect_id     BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    conversation_id BIGINT REFERENCES conversations(id),

    -- CRM cible
    crm_name        VARCHAR(50) NOT NULL DEFAULT 'hubspot',  -- hubspot|pipedrive|notion|custom
    crm_contact_id  VARCHAR(255),          -- ID dans le CRM externe
    crm_deal_id     VARCHAR(255),          -- ID de l'opportunité dans le CRM
    crm_url         TEXT,                  -- URL directe vers la fiche CRM

    -- Statut sync
    status          VARCHAR(30) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','synced','failed','updated','archived')),
    score_at_export INTEGER,               -- score prospect au moment de l'export
    payload         JSONB,                 -- payload envoyé au CRM
    crm_response    JSONB,                 -- réponse du CRM
    error_message   TEXT,

    -- Suivi des mises à jour
    last_sync_at    TIMESTAMPTZ,
    sync_count      INTEGER DEFAULT 0,
    auto_update     BOOLEAN DEFAULT TRUE,  -- mettre à jour automatiquement si score change

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(prospect_id, crm_name)
);

CREATE INDEX idx_crm_sync_status ON crm_sync(status);
CREATE INDEX idx_crm_sync_prospect ON crm_sync(prospect_id);
CREATE INDEX idx_crm_sync_crm_name ON crm_sync(crm_name, status);

-- ─────────────────────────────────────────────────────────────────
-- Vue : v_ab_test_results
-- Résultats agrégés par test et variante pour comparer les perfs.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_ab_test_results AS
SELECT
    test_name,
    variant,
    template_id,
    COUNT(*)                                                    AS sends,
    SUM(got_response::int)                                      AS responses,
    SUM(converted::int)                                         AS conversions,
    ROUND(SUM(got_response::int)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS response_rate_pct,
    ROUND(SUM(converted::int)::numeric / NULLIF(COUNT(*),0) * 100, 1)   AS conversion_rate_pct,
    ROUND(AVG(response_score) FILTER (WHERE response_score IS NOT NULL), 1) AS avg_response_score,
    MIN(sent_at)                                                AS first_send,
    MAX(sent_at)                                                AS last_send
FROM ab_tests
GROUP BY test_name, variant, template_id;

-- ─────────────────────────────────────────────────────────────────
-- Vue : v_template_performance
-- Classement de tous les templates actifs par taux de conversion.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_template_performance AS
SELECT
    t.id,
    t.template_type,
    t.variant,
    t.version,
    t.is_champion,
    t.sends_count,
    t.response_rate,
    t.positive_rate,
    t.conversion_rate,
    t.generated_by,
    t.created_at,
    RANK() OVER (PARTITION BY t.template_type ORDER BY t.conversion_rate DESC NULLS LAST) AS rank_in_type
FROM message_templates t
WHERE t.is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────
-- Vue : v_weekly_learning_data
-- Données agrégées de la semaine courante pour Prompt F.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_weekly_learning_data AS
SELECT
    DATE_TRUNC('week', a.created_at)::date              AS week_start,

    -- Volume
    COUNT(DISTINCT a.id) FILTER (WHERE a.action_type IN ('invite','dm'))   AS total_outreach,
    COUNT(DISTINCT c.id)                                                    AS total_conversations,
    COUNT(DISTINCT c.id) FILTER (WHERE c.score >= 7)                       AS warm_conversations,
    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'hot_lead')              AS hot_leads,
    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'converted')             AS conversions,

    -- Performance par plateforme
    COUNT(DISTINCT a.id) FILTER (WHERE a.platform = 'linkedin' AND a.action_type = 'invite') AS li_invites,
    COUNT(DISTINCT a.id) FILTER (WHERE a.platform = 'linkedin' AND a.status = 'success')     AS li_success,
    COUNT(DISTINCT a.id) FILTER (WHERE a.platform = 'instagram' AND a.action_type = 'dm')   AS ig_dms,
    COUNT(DISTINCT a.id) FILTER (WHERE a.platform = 'instagram' AND a.status = 'success')   AS ig_success,

    -- Scores moyens
    ROUND(AVG(c.score) FILTER (WHERE c.score IS NOT NULL), 2)      AS avg_conversation_score,
    ROUND(AVG(p.profile_score) FILTER (WHERE p.status IN ('hot_lead','converted')), 2) AS avg_converted_score

FROM actions a
LEFT JOIN prospects p ON a.prospect_id = p.id
LEFT JOIN conversations c ON c.prospect_id = p.id
WHERE a.created_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
  AND a.created_at <  DATE_TRUNC('week', NOW())
GROUP BY DATE_TRUNC('week', a.created_at)::date;

-- ─────────────────────────────────────────────────────────────────
-- Triggers updated_at pour les nouvelles tables
-- ─────────────────────────────────────────────────────────────────
CREATE TRIGGER trg_message_templates_updated_at
    BEFORE UPDATE ON message_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_crm_sync_updated_at
    BEFORE UPDATE ON crm_sync
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────
-- Données initiales : templates de base (version 1, variant A)
-- ─────────────────────────────────────────────────────────────────
INSERT INTO message_templates (template_type, variant, version, is_active, is_champion, generated_by,
    system_prompt, user_prompt, model, max_tokens, notes)
VALUES
(
    'outreach_linkedin', 'A', 1, TRUE, TRUE, 'human',
    'Tu es un expert en vente B2B et en outreach LinkedIn. Tu génères des messages de connexion courts, personnalisés et authentiques. Le message doit faire maximum 280 caractères, mentionner un fait spécifique sur la personne, ne pas être commercial, être en français sauf contexte anglophone, paraître naturellement humain.',
    'Génère un message de connexion LinkedIn pour :\nPrénom : {{first_name}}\nEntreprise : {{company}}\nPoste : {{title}}\nFait public : {{public_fact}}\n\nMessage (max 280 caractères) :',
    'claude-opus-4-7', 400,
    'Template initial v1'
),
(
    'outreach_instagram', 'A', 1, TRUE, TRUE, 'human',
    'Tu génères des premiers messages Instagram DM courts et naturels pour une approche B2B. Le message doit être conversationnel, mentionner un élément spécifique du profil ou du contenu de la personne, maximum 200 caractères, jamais commercial en premier contact.',
    'Génère un DM Instagram pour :\nPrénom : {{first_name}}\nUsername : @{{instagram_username}}\nSecteur : {{industry}}\nFait public : {{public_fact}}\n\nMessage :',
    'claude-opus-4-7', 300,
    'Template initial v1'
),
(
    'followup_j3', 'A', 1, TRUE, TRUE, 'human',
    'Tu génères des messages de relance J+3 après une invitation LinkedIn acceptée sans réponse. Le message doit apporter de la valeur (partage insight, question pertinente), maximum 300 caractères, naturel, jamais insistant.',
    'Génère un message de relance J+3 pour :\nPrénom : {{first_name}}\nPoste : {{title}}\nEntreprise : {{company}}\nMessage initial envoyé : {{initial_message}}\n\nRelance J+3 :',
    'claude-opus-4-7', 400,
    'Template initial v1'
),
(
    'followup_j7', 'A', 1, TRUE, TRUE, 'human',
    'Tu génères des messages de relance J+7, dernier contact avant de classer le prospect comme inactif. Le message doit être très court (1-2 phrases), proposer une sortie honorable au prospect, sans pression.',
    'Génère un message de relance J+7 (dernier contact) pour :\nPrénom : {{first_name}}\nPoste : {{title}}\nEntreprise : {{company}}\n\nRelance J+7 (courte, sans pression) :',
    'claude-opus-4-7', 300,
    'Template initial v1'
)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────
-- Ajout colonne template_id sur la table actions (rétrocompat.)
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE actions
    ADD COLUMN IF NOT EXISTS template_id  BIGINT REFERENCES message_templates(id),
    ADD COLUMN IF NOT EXISTS ab_variant   VARCHAR(10);

-- ─────────────────────────────────────────────────────────────────
-- Ajout colonnes de langue sur la table prospects
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE prospects
    ADD COLUMN IF NOT EXISTS detected_language  VARCHAR(10) DEFAULT 'fr',
    ADD COLUMN IF NOT EXISTS crm_synced         BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS crm_synced_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_learning_score NUMERIC(4,2),
    ADD COLUMN IF NOT EXISTS learning_notes      TEXT;

COMMENT ON COLUMN prospects.detected_language IS 'Langue détectée par Prompt G (fr, en, de, es…)';
COMMENT ON COLUMN prospects.last_learning_score IS 'Score prédit par le modèle d apprentissage local';
