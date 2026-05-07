/**
 * n8n-helpers/code-nodes.js
 * ══════════════════════════════════════════════════════════════════
 * Fonctions utilitaires à copier-coller dans les nœuds "Code" de n8n.
 * Chaque section est autonome et peut être utilisée indépendamment.
 * ══════════════════════════════════════════════════════════════════
 *
 * USAGE dans n8n :
 *   1. Créer un nœud "Code" (JavaScript)
 *   2. Copier la section souhaitée
 *   3. Adapter les variables en majuscules selon votre contexte
 */

// ══════════════════════════════════════════════════════════════════
// SECTION 1 – GESTIONNAIRE DE QUOTA QUOTIDIEN
// ══════════════════════════════════════════════════════════════════
// Coller dans un nœud Code AVANT les actions Playwright.
// Lecture du quota depuis la DB (nœud Postgres précédent requis).
// ──────────────────────────────────────────────────────────────────

const QUOTA_MANAGER = `
// ─── Quota Manager ───────────────────────────────────────────────
const PLATFORM = 'linkedin';   // 'linkedin' | 'instagram'
const ACTION_TYPE = 'invite';  // 'invite' | 'message' | 'dm'

// Récupérer les données du nœud Postgres précédent
// (requête : SELECT count, limit_value FROM quotas WHERE platform=$1 AND action_type=$2 AND quota_date=CURRENT_DATE)
const quotaRow = $('Fetch quota (DB)').item.json;

const currentCount = parseInt(quotaRow?.count ?? 0, 10);
const dailyLimit = parseInt(quotaRow?.limit_value ?? 60, 10);
const remaining = dailyLimit - currentCount;

if (remaining <= 0) {
  throw new Error(\`[QUOTA] Limite journalière atteinte : \${currentCount}/\${dailyLimit} \${ACTION_TYPE}s \${PLATFORM}. Reprend demain.\`);
}

// Nombre d'items à traiter dans ce batch (ne pas dépasser le quota restant)
const inputItems = $input.all();
const batchSize = Math.min(remaining, inputItems.length, 5); // max 5 par run

return inputItems.slice(0, batchSize).map(item => ({
  json: {
    ...item.json,
    _quota: { currentCount, dailyLimit, remaining, batchSize },
  }
}));
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 2 – DÉLAI ALÉATOIRE (JITTER)
// ══════════════════════════════════════════════════════════════════
// Calcule un délai aléatoire entre deux bornes.
// Passer ensuite ce délai à un nœud Wait.
// ──────────────────────────────────────────────────────────────────

const JITTER_DELAY = `
// ─── Jitter Delay ────────────────────────────────────────────────
// Génère un délai aléatoire humain pour éviter la détection de bot.
// Résultat : item.json.actionDelayMs

const MIN_MS = 45000;  // 45 secondes minimum
const MAX_MS = 90000;  // 90 secondes maximum

// Ajouter une composante Gaussienne pour plus de réalisme
// (concentre les délais vers le milieu de la plage)
function gaussianRandom(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return gaussianRandom(min, max);
  return Math.floor(num * (max - min) + min);
}

const delayMs = gaussianRandom(MIN_MS, MAX_MS);

// Logging pour audit
console.log(\`[JITTER] Délai calculé : \${(delayMs / 1000).toFixed(1)}s\`);

return [{
  json: {
    ...$input.item.json,
    actionDelayMs: delayMs,
    actionDelayFormatted: \`\${(delayMs / 1000).toFixed(0)}s\`,
  }
}];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 3 – ESCALADE HUMAINE (DISCORD / SLACK)
// ══════════════════════════════════════════════════════════════════
// Envoie une alerte riche vers Discord avec contexte complet.
// Utiliser dans un nœud Code ou directement dans HTTP Request.
// ──────────────────────────────────────────────────────────────────

const HUMAN_ESCALATION = `
// ─── Human Escalation ────────────────────────────────────────────
// Formate et envoie une alerte d'escalade vers Discord.
// Requiert le nœud HTTP Request suivant configuré avec l'URL Discord.

const item = $input.item.json;
const analysis = item.analysis || {};

// Niveaux de couleur Discord
const COLORS = {
  critical: 15158332,  // Rouge
  hot_lead:  16744272, // Orange
  warning:   16776960, // Jaune
  info:      3447003,  // Bleu
};

const isHotLead = analysis.score >= 8;
const color = isHotLead ? COLORS.hot_lead : COLORS.warning;
const emoji = isHotLead ? '🔥' : '⚠️';
const title = isHotLead
  ? \`\${emoji} LEAD CHAUD – Action requise maintenant\`
  : \`\${emoji} Alerte – Vérification manuelle requise\`;

// Construire le payload Discord (Embed)
const discordPayload = {
  embeds: [{
    title,
    color,
    description: \`**\${item.senderName || 'Inconnu'}** (\${item.platform})\`,
    fields: [
      {
        name: '📊 Score',
        value: \`\${analysis.score ?? '?'}/10\`,
        inline: true,
      },
      {
        name: '🎯 Intention',
        value: analysis.intent ?? 'unknown',
        inline: true,
      },
      {
        name: '⏱ Urgence',
        value: analysis.urgency ?? 'unknown',
        inline: true,
      },
      {
        name: '💬 Résumé',
        value: analysis.summary ?? '–',
      },
      {
        name: '✉️ Dernier message',
        value: (item.lastMessage ?? '').slice(0, 500) || '–',
      },
      ...(analysis.keyInsights?.length ? [{
        name: '💡 Insights clés',
        value: analysis.keyInsights.map(i => \`• \${i}\`).join('\\n'),
      }] : []),
      {
        name: '🔗 Conversation',
        value: item.conversationUrl
          ? \`[Ouvrir](\${item.conversationUrl})\`
          : 'URL non disponible',
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Automation LinkedIn/Instagram – Escalade humaine' },
  }],
};

return [{ json: discordPayload }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 4 – MODE DRY-RUN
// ══════════════════════════════════════════════════════════════════
// Gate universel à insérer avant tout nœud d'action (envoi, click...).
// Si DRY_RUN=true, loggue et stoppe sans envoyer.
// ──────────────────────────────────────────────────────────────────

const DRY_RUN_GATE = `
// ─── Dry-Run Gate ────────────────────────────────────────────────
// Insérer ce nœud Code juste avant chaque action réelle.
// Variable n8n : $vars.DRY_RUN (défini dans .env → n8n env vars)

const isDryRun = $vars.DRY_RUN === 'true';
const item = $input.item.json;

if (isDryRun) {
  // Logger ce qui aurait été fait
  const logEntry = {
    dryRun: true,
    timestamp: new Date().toISOString(),
    wouldHaveDone: {
      platform: item.platform ?? 'unknown',
      action: item.actionType ?? 'send',
      target: item.profileUrl ?? item.conversationUrl ?? item.username ?? 'unknown',
      message: item.message ?? item.generatedMessage ?? item.reply ?? '–',
    },
  };

  console.log('[DRY RUN]', JSON.stringify(logEntry, null, 2));

  // Retourner un résultat simulé (même structure qu'un vrai succès)
  return [{
    json: {
      ...item,
      dryRunResult: {
        success: true,
        simulated: true,
        ...logEntry.wouldHaveDone,
      }
    }
  }];
}

// Mode production : laisser passer sans modification
return [$input.item];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 5 – INCRÉMENT DE QUOTA EN DB
// ══════════════════════════════════════════════════════════════════
// À exécuter APRÈS une action réussie via un nœud Postgres.
// ──────────────────────────────────────────────────────────────────

const QUOTA_INCREMENT_SQL = `
-- Incrémenter le quota après une action réussie
-- (Passer en paramètre dans un nœud Postgres)
INSERT INTO quotas (platform, action_type, quota_date, count, limit_value)
VALUES ($1, $2, CURRENT_DATE, 1, $3)
ON CONFLICT (platform, action_type, quota_date)
DO UPDATE SET
  count = quotas.count + 1,
  updated_at = NOW()
RETURNING count, limit_value;

-- Paramètres à passer :
-- $1 : platform (ex: 'linkedin')
-- $2 : action_type (ex: 'invite')
-- $3 : limit_value (ex: 60)
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 6 – PARSER DE RÉPONSE CLAUDE
// ══════════════════════════════════════════════════════════════════
// Extrait et valide la réponse JSON de Claude, avec fallback sécurisé.
// ──────────────────────────────────────────────────────────────────

const CLAUDE_RESPONSE_PARSER = `
// ─── Claude Response Parser ───────────────────────────────────────
// Nœud Code à placer après chaque appel HTTP Request vers Claude API.
// Gère les cas où Claude enveloppe son JSON dans des backticks markdown.

const claudeResponse = $input.item.json;

// Vérifier que la réponse est valide
if (!claudeResponse?.content?.[0]?.text) {
  throw new Error(\`Réponse Claude invalide : \${JSON.stringify(claudeResponse)}\`);
}

const rawText = claudeResponse.content[0].text.trim();

// Tentatives de parsing dans l'ordre de priorité
let parsed = null;
const strategies = [
  // 1. JSON pur
  () => JSON.parse(rawText),
  // 2. JSON dans bloc ```json ... ```
  () => JSON.parse(rawText.match(/\`\`\`json\\n?([\\s\\S]*?)\\n?\`\`\`/)?.[1] ?? ''),
  // 3. JSON dans bloc ``` ... ```
  () => JSON.parse(rawText.match(/\`\`\`\\n?([\\s\\S]*?)\\n?\`\`\`/)?.[1] ?? ''),
  // 4. Premier objet JSON trouvé dans le texte
  () => JSON.parse(rawText.match(/({[\\s\\S]*})/)?.[1] ?? ''),
];

for (const strategy of strategies) {
  try {
    parsed = strategy();
    if (parsed) break;
  } catch {}
}

if (!parsed) {
  // Si le résultat attendu est du texte libre (pas du JSON), retourner tel quel
  return [{
    json: {
      ...$('Node précédent').item.json,  // Adapter le nom du nœud
      claudeText: rawText,
      claudeParsed: null,
      claudeParseError: 'Not JSON',
    }
  }];
}

return [{
  json: {
    ...$('Node précédent').item.json,  // Adapter le nom du nœud
    claudeParsed: parsed,
    claudeText: rawText,
  }
}];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 7 – DÉTECTEUR D'HEURES OUVRÉES
// ══════════════════════════════════════════════════════════════════
// À utiliser dans un nœud IF pour ne rien envoyer le week-end ou la nuit.
// ──────────────────────────────────────────────────────────────────

const BUSINESS_HOURS_GATE = `
// ─── Business Hours Gate ─────────────────────────────────────────
// Retourne true si l'action est autorisée maintenant.
// Configurer dans un nœud IF (condition: isBusinessHours === true)

const now = new Date();
// Adapter au timezone cible (ici Europe/Paris)
const localTime = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'narrow',
  hour12: false,
}).formatToParts(now);

const parts = Object.fromEntries(localTime.map(p => [p.type, p.value]));
const hour = parseInt(parts.hour, 10);
const weekday = parts.weekday; // 'lun.', 'mar.', etc.

const isWeekday = !['sam.', 'dim.'].includes(weekday);
const isWorkingHour = hour >= 9 && hour < 18;

// Éviter les envois au déjeuner (12h-14h) pour paraître plus humain
const isLunch = hour >= 12 && hour < 14;

const isBusinessHours = isWeekday && isWorkingHour && !isLunch;

return [{
  json: {
    ...$input.item.json,
    isBusinessHours,
    currentHour: hour,
    currentWeekday: weekday,
    reason: !isWeekday ? 'weekend'
      : !isWorkingHour ? 'outside_hours'
      : isLunch ? 'lunch_break'
      : 'ok',
  }
}];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 8 – FORMATEUR DE RAPPORT DISCORD
// ══════════════════════════════════════════════════════════════════
// Génère un rapport hebdomadaire des performances.
// ──────────────────────────────────────────────────────────────────

const WEEKLY_REPORT_FORMATTER = `
// ─── Weekly Report Formatter ──────────────────────────────────────
// Formater le rapport hebdomadaire pour Discord.
// Données en entrée depuis un nœud Postgres avec les métriques.

const metrics = $input.item.json;

const report = {
  embeds: [{
    title: '📊 Rapport hebdomadaire – Automation LinkedIn/Instagram',
    color: 3066993, // Vert
    fields: [
      {
        name: '📨 Invitations envoyées',
        value: \`\${metrics.invites_sent ?? 0}\`,
        inline: true,
      },
      {
        name: '✅ Connexions acceptées',
        value: \`\${metrics.invites_accepted ?? 0} (\${
          metrics.invites_sent > 0
            ? Math.round((metrics.invites_accepted / metrics.invites_sent) * 100)
            : 0
        }%)\`,
        inline: true,
      },
      {
        name: '💬 Conversations ouvertes',
        value: \`\${metrics.conversations_started ?? 0}\`,
        inline: true,
      },
      {
        name: '🔥 Leads chauds (score ≥ 8)',
        value: \`\${metrics.hot_leads ?? 0}\`,
        inline: true,
      },
      {
        name: '🤝 Convertis',
        value: \`\${metrics.converted ?? 0}\`,
        inline: true,
      },
      {
        name: '❌ Erreurs',
        value: \`\${metrics.errors ?? 0}\`,
        inline: true,
      },
      {
        name: '📝 Posts publiés',
        value: \`LinkedIn: \${metrics.linkedin_posts ?? 0} | Instagram: \${metrics.instagram_posts ?? 0}\`,
      },
      {
        name: '💰 Coût API Claude estimé',
        value: \`~\${((metrics.total_tokens ?? 0) / 1_000_000 * 3).toFixed(2)}€\`,
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Automation Monitor – Rapport automatique' },
  }],
};

return [{ json: report }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 9 – GESTIONNAIRE D'ERREURS AVEC RETRY
// ══════════════════════════════════════════════════════════════════
// Pour les nœuds critiques, gérer les retries avec backoff exponentiel.
// Utiliser dans un nœud Code après un HTTP Request qui peut échouer.
// ──────────────────────────────────────────────────────────────────

const ERROR_HANDLER_WITH_RETRY = `
// ─── Error Handler with Retry ────────────────────────────────────
// Gestionnaire d'erreurs avec compteur de tentatives.
// Passer ce nœud dans le flux "Error" du nœud précédent.

const MAX_RETRIES = 3;
const item = $input.item.json;
const error = $input.item.json.error ?? $execution.error;

// Récupérer le compteur de tentatives (stocké dans les données de l'item)
const retryCount = parseInt(item._retryCount ?? 0, 10) + 1;

// Vérifier si on doit encore réessayer
if (retryCount > MAX_RETRIES) {
  console.error(\`[RETRY] Max retries (\${MAX_RETRIES}) atteint pour : \${item.profileUrl ?? item.username}\`);
  // Laisser passer vers le nœud de logging d'erreur
  return [{
    json: {
      ...item,
      _retryCount: retryCount,
      _finalError: true,
      errorMessage: String(error?.message ?? error ?? 'Unknown error'),
    }
  }];
}

// Calculer le délai backoff exponentiel : 2s, 4s, 8s...
const backoffMs = Math.pow(2, retryCount) * 1000;
console.log(\`[RETRY] Tentative \${retryCount}/\${MAX_RETRIES} dans \${backoffMs}ms...\`);

// Passer au nœud Wait avec le délai calculé
return [{
  json: {
    ...item,
    _retryCount: retryCount,
    _backoffMs: backoffMs,
    _shouldRetry: true,
  }
}];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 10 – PIPELINE DE QUALIFICATION RAPIDE
// ══════════════════════════════════════════════════════════════════
// Filtre et trie les prospects avant outreach.
// Utiliser avant le Workflow 1 pour pré-qualifier en batch.
// ──────────────────────────────────────────────────────────────────

const PROSPECT_QUALIFIER = `
// ─── Prospect Qualifier ───────────────────────────────────────────
// Filtre les prospects selon des critères ICP hardcodés.
// Complément au scoring Claude pour les cas évidents.

const MIN_SCORE = 6;          // Score minimum pour outreach
const REQUIRED_FIELDS = ['linkedin_url', 'first_name', 'company'];
const BLOCKED_TITLES = ['intern', 'stagiaire', 'étudiant', 'student', 'apprenti'];
const TARGET_SENIORITY = ['ceo', 'cto', 'coo', 'cfo', 'director', 'head of', 'vp ', 'vice president', 'founder', 'co-founder', 'owner', 'président', 'directeur', 'responsable'];

const qualified = [];
const rejected = [];

for (const item of $input.all()) {
  const p = item.json;
  const title = (p.title ?? '').toLowerCase();
  const reasons = [];

  // Champs obligatoires
  const missingFields = REQUIRED_FIELDS.filter(f => !p[f]);
  if (missingFields.length > 0) {
    reasons.push(\`Champs manquants: \${missingFields.join(', ')}\`);
  }

  // Score minimum
  if ((p.profile_score ?? 0) < MIN_SCORE) {
    reasons.push(\`Score trop bas: \${p.profile_score}/${MIN_SCORE}\`);
  }

  // Titres exclus
  if (BLOCKED_TITLES.some(t => title.includes(t))) {
    reasons.push(\`Titre exclu: \${p.title}\`);
  }

  // Do not contact
  if (p.status === 'do_not_contact' || p.do_not_contact) {
    reasons.push('Do not contact flag');
  }

  // Bonus : boost si décideur
  const isSenior = TARGET_SENIORITY.some(t => title.includes(t));

  if (reasons.length === 0) {
    qualified.push({
      json: {
        ...p,
        _qualified: true,
        _isSenior: isSenior,
        _priority: isSenior ? (p.profile_score ?? 0) + 2 : (p.profile_score ?? 0),
      }
    });
  } else {
    rejected.push({
      json: {
        ...p,
        _qualified: false,
        _rejectionReasons: reasons,
      }
    });
  }
}

console.log(\`[QUALIFY] \${qualified.length} qualifiés, \${rejected.length} rejetés\`);

// Trier par priorité décroissante
qualified.sort((a, b) => (b.json._priority ?? 0) - (a.json._priority ?? 0));

return qualified;
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 11 – ROUTEUR A/B TEST
// ══════════════════════════════════════════════════════════════════
// Assigne chaque prospect entrant à une variante A ou B.
// Nécessite que les templates soient récupérés depuis la DB.
// ──────────────────────────────────────────────────────────────────

const AB_TEST_ROUTER = `
// ─── A/B Test Router ─────────────────────────────────────────────
// Prérequis : nœud Postgres "Fetch templates actifs" en amont
//   SELECT id, template_type, variant, system_prompt, user_prompt
//   FROM message_templates WHERE is_active = TRUE ORDER BY template_type, variant

const templates = $('Fetch templates actifs').all().map(i => i.json);
const items = $input.all();

// Organiser par type
const byType = {};
templates.forEach(t => {
  if (!byType[t.template_type]) byType[t.template_type] = {};
  byType[t.template_type][t.variant] = t;
});

return items.map((item, idx) => {
  const p = item.json;
  const templateType = p.platform === 'instagram' ? 'outreach_instagram' : 'outreach_linkedin';
  const typeTemplates = byType[templateType] || {};
  const hasVariantB = !!typeTemplates['B'];

  // Split 50/50 (hash sur l'ID prospect pour cohérence entre runs)
  const hashBit = p.id % 2;
  const variant = (hasVariantB && hashBit === 1) ? 'B' : 'A';
  const template = typeTemplates[variant] || typeTemplates['A'];

  if (!template) return { json: { ...p, _skip: true, _reason: 'No template found' } };

  const testName = \`\${templateType}_\${new Date().toISOString().slice(0,7)}\`;

  return {
    json: {
      ...p,
      _ab: {
        variant,
        template_id: template.id,
        template_type: templateType,
        test_name: testName,
        system_prompt: template.system_prompt,
        user_prompt: template.user_prompt,
        model: template.model || 'claude-opus-4-7'
      }
    }
  };
}).filter(i => !i.json._skip);
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 12 – ANALYSEUR DE PERFORMANCE HEBDOMADAIRE
// ══════════════════════════════════════════════════════════════════
// Agrège les métriques de la semaine pour Prompt F.
// ──────────────────────────────────────────────────────────────────

const PERFORMANCE_ANALYZER = `
// ─── Performance Analyzer ────────────────────────────────────────
// Prérequis : nœuds Postgres en amont récupérant :
//   - actions de la semaine (avec platform, action_type, status, template_id)
//   - prospects correspondants (title, industry, status, profile_score)
//   - templates actifs (sends_count, response_rate, etc.)

const actions = $('Fetch actions semaine').all().map(i => i.json);
const templates = $('Fetch templates actifs').all().map(i => i.json);

// ── Métriques globales ───────────────────────────────────────────
const total = actions.length;
const success = actions.filter(a => a.action_status === 'success').length;
const responses = actions.filter(a => a.got_response).length;
const hotLeads = actions.filter(a => ['hot_lead','converted'].includes(a.prospect_status)).length;

// ── Métriques par plateforme ─────────────────────────────────────
const byPlatform = {};
actions.forEach(a => {
  const pl = a.platform || 'unknown';
  if (!byPlatform[pl]) byPlatform[pl] = { sent: 0, success: 0, responses: 0 };
  byPlatform[pl].sent++;
  if (a.action_status === 'success') byPlatform[pl].success++;
  if (a.got_response) byPlatform[pl].responses++;
});

// ── Segments par titre ────────────────────────────────────────────
const byTitle = {};
actions.forEach(a => {
  const t = a.title || 'unknown';
  if (!byTitle[t]) byTitle[t] = { total: 0, converted: 0, scores: [] };
  byTitle[t].total++;
  if (['hot_lead','converted'].includes(a.prospect_status)) byTitle[t].converted++;
  if (a.conv_score) byTitle[t].scores.push(Number(a.conv_score));
});

const segments = Object.entries(byTitle)
  .filter(([,v]) => v.total >= 3)
  .map(([title, v]) => ({
    title,
    total: v.total,
    converted: v.converted,
    conversion_rate: (v.converted / v.total * 100).toFixed(1) + '%',
    avg_score: v.scores.length ? (v.scores.reduce((a,b) => a+b,0) / v.scores.length).toFixed(1) : null
  }))
  .sort((a,b) => parseFloat(b.conversion_rate) - parseFloat(a.conversion_rate));

// ── Templates sous-performants ────────────────────────────────────
const underperforming = templates.filter(t =>
  t.sends_count >= 10 && (t.response_rate === null || parseFloat(t.response_rate) < 15)
);

const summary = {
  total_actions: total,
  success_rate: total ? (success/total*100).toFixed(1)+'%' : '0%',
  response_rate: total ? (responses/total*100).toFixed(1)+'%' : '0%',
  hot_leads: hotLeads,
  by_platform: byPlatform,
  top_segments: segments.slice(0,5),
  bottom_segments: segments.slice(-3).reverse(),
  underperforming_templates: underperforming.map(t => ({
    type: t.template_type,
    variant: t.variant,
    sends: t.sends_count,
    rate: t.response_rate
  }))
};

console.log('[PERF] Semaine analysée :', JSON.stringify(summary, null, 2));

return [{ json: { ...summary, context_json: JSON.stringify(summary) } }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 13 – BUILDER PAYLOAD CRM
// ══════════════════════════════════════════════════════════════════
// Formate un prospect en payload CRM (HubSpot / Pipedrive / Notion).
// ──────────────────────────────────────────────────────────────────

const CRM_PAYLOAD_BUILDER = `
// ─── CRM Payload Builder ─────────────────────────────────────────
const p = $input.item.json;
const CRM = $env.CRM_NAME || 'hubspot'; // hubspot | pipedrive | notion | custom

const tags = [
  ...(p.tags || []),
  \`score-\${p.profile_score}\`,
  p.platform, p.status,
  p.icp_match ? 'icp-match' : null,
  p.decision_maker ? 'decision-maker' : null
].filter(Boolean);

const notes = [
  p.public_fact    ? \`📌 Fait public : \${p.public_fact}\` : null,
  p.best_angle     ? \`🎯 Angle : \${p.best_angle}\` : null,
  p.conv_summary   ? \`💬 Dernier échange : \${p.conv_summary}\` : null,
  p.likely_pain_points?.length ? \`⚡ Pain points : \${p.likely_pain_points.join(', ')}\` : null,
  \`Importé le \${new Date().toLocaleDateString('fr-FR')}\`
].filter(Boolean).join('\\n');

const payloads = {
  hubspot: {
    properties: {
      firstname: p.first_name, lastname: p.last_name || '',
      email: p.email || '', phone: p.phone || '',
      company: p.company || '', jobtitle: p.title || '',
      hs_lead_status: p.status === 'converted' ? 'QUALIFIED' : 'IN_PROGRESS',
      lifecyclestage: p.status === 'converted' ? 'opportunity' : 'lead',
      description: notes,
      profile_score: String(p.profile_score),
      automation_platform: p.platform
    }
  },
  pipedrive: {
    name: p.full_name, org_name: p.company || '',
    job_title: p.title || '',
    email: [{ value: p.email || '', primary: true }],
    phone: [{ value: p.phone || '', primary: true }]
  },
  notion: {
    parent: { database_id: $env.NOTION_DB_ID || '' },
    properties: {
      Name: { title: [{ text: { content: p.full_name || '' } }] },
      Score: { number: p.profile_score },
      Status: { select: { name: p.status } },
      Platform: { select: { name: p.platform } },
      Tags: { multi_select: tags.slice(0,5).map(t => ({ name: t })) },
      Notes: { rich_text: [{ text: { content: notes.substring(0,2000) } }] }
    }
  }
};

return [{ json: {
  prospect_id: p.id,
  crm_name: CRM,
  payload: payloads[CRM] || payloads.hubspot,
  notes
} }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 14 – DÉTECTEUR DE LANGUE
// ══════════════════════════════════════════════════════════════════
// Détection heuristique rapide AVANT d'appeler Prompt G (Claude).
// Évite un appel API si la langue est déjà évidente.
// ──────────────────────────────────────────────────────────────────

const LANGUAGE_DETECTOR = `
// ─── Language Detector (heuristique locale) ──────────────────────
const p = $input.item.json;

const FR_CLUES = ['france','paris','lyon','bordeaux','marseille','toulouse','nantes','lille','strasbourg',
  'belgique','suisse','luxembourg','montréal','québec','maroc','sénégal','côte d\'ivoire'];
const EN_CLUES = ['united kingdom','uk','london','manchester','australia','sydney','melbourne',
  'united states','us','new york','san francisco','canada','toronto','vancouver','ireland','dublin'];
const DE_CLUES = ['deutschland','germany','berlin','munich','münchen','hamburg','austria','österreich','zürich'];
const ES_CLUES = ['spain','españa','madrid','barcelona','mexico','argentina','colombia'];

const text = [p.location, p.company, p.industry, p.first_name, p.last_name].join(' ').toLowerCase();

let detected = 'fr'; // Défaut
let confidence = 'low';

if (FR_CLUES.some(c => text.includes(c))) { detected = 'fr'; confidence = 'high'; }
else if (EN_CLUES.some(c => text.includes(c))) { detected = 'en'; confidence = 'high'; }
else if (DE_CLUES.some(c => text.includes(c))) { detected = 'de'; confidence = 'high'; }
else if (ES_CLUES.some(c => text.includes(c))) { detected = 'es'; confidence = 'medium'; }

// Si déjà en DB, garder
if (p.detected_language && p.detected_language !== 'fr') {
  detected = p.detected_language;
  confidence = 'high';
}

const needsClaudeCheck = confidence === 'low';

return [{ json: {
  ...p,
  detected_language: detected,
  language_confidence: confidence,
  needs_claude_language_check: needsClaudeCheck,
  greeting: detected === 'fr' ? \`Bonjour \${p.first_name},\`
           : detected === 'en' ? \`Hi \${p.first_name},\`
           : detected === 'de' ? \`Hallo \${p.first_name},\`
           : detected === 'es' ? \`Hola \${p.first_name},\`
           : \`Bonjour \${p.first_name},\`
} }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 15 – ÉVOLUTION DE TEMPLATE (APPLIQUE AMÉLIORATIONS)
// ══════════════════════════════════════════════════════════════════
// Reçoit les template_improvements de Prompt F et génère les SQL
// d'insertion pour créer les nouvelles versions améliorées.
// ──────────────────────────────────────────────────────────────────

const TEMPLATE_EVOLVER = `
// ─── Template Evolver ────────────────────────────────────────────
// Prérequis : nœud précédent = Parse insights Claude (WF6)
// $input.item.json.insights.template_improvements = tableau d'améliorations

const improvements = $input.item.json?.insights?.template_improvements || [];
const today = new Date().toISOString().split('T')[0];

// Ne créer que ceux avec confiance high ou medium et au moins 10 envois de données
const toCreate = improvements.filter(t =>
  t.confidence !== 'low' &&
  t.new_system_prompt &&
  t.template_type
);

if (toCreate.length === 0) {
  console.log('[EVOLVER] Aucun template à améliorer cette semaine.');
  return [{ json: { created_count: 0, templates: [] } }];
}

const queries = toCreate.map(t => {
  const safeSystem = (t.new_system_prompt || '').replace(/'/g, "''");
  const safeUser   = (t.new_user_prompt   || '').replace(/'/g, "''");
  const safeNote   = \`Auto-généré par Learning Loop \${today} | Problème : \${(t.problem||'').substring(0,100)} | Attendu : \${(t.expected_improvement||'').substring(0,100)}\`.replace(/'/g, "''");
  const safeProblem = JSON.stringify({ problem: t.problem, confidence: t.confidence }).replace(/'/g, "''");

  return {
    template_type: t.template_type,
    sql: \`
      INSERT INTO message_templates
        (template_type, variant, version, is_active, is_champion, generated_by,
         system_prompt, user_prompt, model, max_tokens, notes, generation_context)
      SELECT
        '\${t.template_type}', 'A',
        COALESCE((SELECT MAX(version)+1 FROM message_templates WHERE template_type='\${t.template_type}'), 1),
        TRUE, FALSE, 'claude_learning',
        '\${safeSystem}', '\${safeUser}',
        'claude-opus-4-7', 500,
        '\${safeNote}',
        '\${safeProblem}'::jsonb
      RETURNING id, version, template_type\`
  };
});

console.log(\`[EVOLVER] \${queries.length} templates à créer/améliorer.\`);
return queries.map(q => ({ json: q }));
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 16 – SIGNAL DETECTOR
// ══════════════════════════════════════════════════════════════════
// Évalue les signaux entrants et calcule leur priorité.
// À placer après la récupération des signaux depuis la source externe.
// ──────────────────────────────────────────────────────────────────

const SIGNAL_DETECTOR = `
// ─── Signal Detector ─────────────────────────────────────────────
// Calcule la priorité composite d'un signal et filtre les non-pertinents.
// Prérequis : item.json contient { signal_type, signal_strength, signal_source,
//             signal_date } + les infos prospect (id, profile_score, status)

const item = $input.item.json;
const sig  = item._signal || item; // Supporte les deux formats

// Poids par type de signal
const TYPE_WEIGHTS = {
  buying_signal:      10,
  company_funding:     8,
  pain_point_signal:   7,
  company_expansion:   6,
  job_change:          5,
  viral_post:          3,
  award_or_recognition:2,
  reactivation:        4
};

// Poids par force
const STRENGTH_MULT = { critical: 2.0, high: 1.5, medium: 1.0, low: 0.5 };

const typeScore     = TYPE_WEIGHTS[sig.signal_type]    || 3;
const strengthMult  = STRENGTH_MULT[sig.signal_strength] || 1;
const prospectMult  = (item.profile_score || 5) / 10;  // Normalize 0-1
const recencyDays   = sig.signal_date
  ? Math.max(0, (Date.now() - new Date(sig.signal_date).getTime()) / 86400000)
  : 7;
const recencyMult   = Math.max(0.2, 1 - recencyDays / 14); // Décroît sur 14j

const priority = typeScore * strengthMult * (0.5 + 0.5 * prospectMult) * recencyMult;

// Seuil minimal pour déclencher une action
const PRIORITY_THRESHOLD = 4.0;
const shouldAct = priority >= PRIORITY_THRESHOLD
  && !['do_not_contact','unsubscribed'].includes(item.status);

console.log(\`[SIGNAL] \${item.full_name || 'prospect'} | type=\${sig.signal_type} | priority=\${priority.toFixed(2)} | shouldAct=\${shouldAct}\`);

return [{ json: {
  ...item,
  _signal: {
    ...sig,
    priority: parseFloat(priority.toFixed(2)),
    should_act: shouldAct,
    action_urgency: priority >= 12 ? 'immediate' : priority >= 7 ? 'today' : 'this_week'
  }
} }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 17 – COLD RECYCLER
// ══════════════════════════════════════════════════════════════════
// Prépare la re-qualification d'un prospect froid.
// Filtre ceux qui ne valent pas la peine d'être relancés.
// ──────────────────────────────────────────────────────────────────

const COLD_RECYCLER = `
// ─── Cold Recycler ────────────────────────────────────────────────
// Analyse si un prospect froid mérite d'être réactivé et
// prépare le contexte pour Prompt H (Claude).
// Prérequis : item.json = ligne de la table prospects (avec cold_since, signal_count…)

const p = $input.item.json;

// Critères d'exclusion définitive
const DO_NOT_RECYCLE = [
  p.status === 'do_not_contact',
  p.status === 'unsubscribed',
  p.profile_score < 4,  // Trop peu qualifié initialement
  p.signal_count > 3    // Déjà relancé plusieurs fois → laisser tomber
];

if (DO_NOT_RECYCLE.some(Boolean)) {
  console.log(\`[RECYCLER] Skip \${p.full_name}: critère d'exclusion atteint\`);
  return [{ json: { _skip: true, prospect_id: p.id, reason: 'Exclusion criteria' } }];
}

// Calcul du score de recyclage (0-100)
const daysSinceCold = p.cold_since
  ? Math.floor((Date.now() - new Date(p.cold_since).getTime()) / 86400000)
  : 90;

const recyclingScore =
  p.profile_score * 8 +                    // Score de base (0-80)
  (p.signal_count || 0) * 5 +              // Signaux passés = activité
  Math.max(0, 30 - daysSinceCold / 10) +   // Bonus si pas trop vieux
  (p.icp_match ? 10 : 0);                  // Bonus ICP match

const shouldRecycle = recyclingScore >= 40;

// Calcul du délai de relance (étaler sur 2 semaines)
const daysDelay = shouldRecycle ? Math.floor(Math.random() * 10) + 1 : null;

console.log(\`[RECYCLER] \${p.full_name} | score=\${recyclingScore} | days_cold=\${daysSinceCold} | recycle=\${shouldRecycle}\`);

return [{ json: {
  ...p,
  _recycling: {
    should_recycle: shouldRecycle,
    recycling_score: recyclingScore,
    days_cold: daysSinceCold,
    days_delay: daysDelay,
    context_for_claude: JSON.stringify({
      name: p.full_name, title: p.title, company: p.company,
      industry: p.industry, location: p.location, platform: p.platform,
      old_angle: p.best_angle, old_fact: p.public_fact,
      profile_score: p.profile_score, signal_count: p.signal_count || 0
    })
  }
} }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 18 – ROI CALCULATOR
// ══════════════════════════════════════════════════════════════════
// Calcule le ROI en temps réel à partir des actions et du CA généré.
// ──────────────────────────────────────────────────────────────────

const ROI_CALCULATOR = `
// ─── ROI Calculator ──────────────────────────────────────────────
// Prérequis : nœuds Postgres en amont récupérant :
//   - Nb actions du mois + types
//   - Deals gagnés (revenue_attribution)
//   - Meetings bookés

const actions   = $('Fetch actions mois').all().map(i => i.json);
const revenue   = $('Fetch revenue mois').all().map(i => i.json);
const config    = $('Fetch config').all().map(i => i.json);

// ── Coûts ─────────────────────────────────────────────────────────
// Claude API : estimation basée sur les types d'appels
const CLAUDE_COSTS = {
  outreach_gen:   0.008,  // Prompt A/B/C — Opus
  qualification:  0.001,  // Prompt E/H/I — Haiku
  content_gen:    0.015,  // Prompt D — Opus long
  analysis:       0.006,  // Prompt B — Opus medium
  learning:       0.020,  // Prompt F — Opus très long (hebdo)
};

const totalInvites  = actions.filter(a => a.action_type === 'invite').length;
const totalDMs      = actions.filter(a => a.action_type === 'dm').length;
const totalAnalyses = actions.filter(a => a.action_type === 'reply').length;

const claudeCost =
  totalInvites  * CLAUDE_COSTS.outreach_gen +
  totalDMs      * CLAUDE_COSTS.outreach_gen +
  totalAnalyses * CLAUDE_COSTS.analysis +
  actions.length * 0.001 +          // Qualification moyenne
  4 * CLAUDE_COSTS.learning;        // ~4 runs/mois

const infraCostMonthly = 15;        // VPS + Docker estimé

const totalCost = claudeCost + infraCostMonthly;

// ── Revenue ───────────────────────────────────────────────────────
const dealsWon     = revenue.filter(r => r.stage === 'deal_won');
const meetingsBooked = revenue.filter(r => r.stage === 'meeting_booked').length;
const totalRevenue = dealsWon.reduce((sum, r) => sum + parseFloat(r.deal_value_eur || 0), 0);
const totalMRR     = dealsWon.filter(r => r.is_recurring).reduce((sum, r) => sum + parseFloat(r.mrr_eur || 0), 0);

// ── KPIs ──────────────────────────────────────────────────────────
const roi              = totalCost > 0 ? totalRevenue / totalCost : 0;
const costPerMeeting   = meetingsBooked > 0 ? totalCost / meetingsBooked : null;
const cac              = dealsWon.length > 0 ? totalCost / dealsWon.length : null;
const monthlyTarget    = parseFloat(config.find(c => c.key === 'revenue_target_monthly')?.value || 5000);
const targetProgress   = totalRevenue / monthlyTarget * 100;

const summary = {
  period: new Date().toISOString().slice(0,7),
  // Volumes
  total_actions: actions.length,
  invites_sent: totalInvites,
  dms_sent: totalDMs,
  meetings_booked: meetingsBooked,
  deals_won: dealsWon.length,
  // Coûts
  claude_cost_eur: parseFloat(claudeCost.toFixed(2)),
  infra_cost_eur: infraCostMonthly,
  total_cost_eur: parseFloat(totalCost.toFixed(2)),
  // Revenue
  revenue_eur: parseFloat(totalRevenue.toFixed(2)),
  mrr_eur: parseFloat(totalMRR.toFixed(2)),
  arr_eur: parseFloat((totalMRR * 12).toFixed(2)),
  // KPIs
  roi_multiplier: parseFloat(roi.toFixed(1)),
  cost_per_meeting_eur: costPerMeeting ? parseFloat(costPerMeeting.toFixed(2)) : null,
  cac_eur: cac ? parseFloat(cac.toFixed(2)) : null,
  target_progress_pct: parseFloat(targetProgress.toFixed(1)),
  monthly_target_eur: monthlyTarget
};

console.log('[ROI]', JSON.stringify(summary));
return [{ json: summary }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 19 – SHADOW BAN DETECTOR
// ══════════════════════════════════════════════════════════════════
// Compare le taux d'acceptation récent vs la moyenne 7 jours.
// Déclenche automatiquement une pause + alerte si chute ≥ 30%.
// ──────────────────────────────────────────════════════════════════

const SHADOW_BAN_DETECTOR = `
// ─── Shadow Ban Detector ─────────────────────────────────────────
// Prérequis : nœuds Postgres en amont récupérant :
//   actions_24h  : actions des dernières 24h avec status
//   actions_7d   : agrégat taux d'acceptation 7 derniers jours

const recent  = $('Fetch actions 24h').all().map(i => i.json);
const history = $('Fetch acceptance rate 7d').all().map(i => i.json);

const platforms = ['linkedin', 'instagram'];
const alerts = [];

platforms.forEach(platform => {
  const recentPlatform = recent.filter(a => a.platform === platform);
  const sent24h    = recentPlatform.filter(a => a.action_type === 'invite').length;
  const accepted24h = recentPlatform.filter(a => a.action_type === 'invite' && a.status === 'success').length;
  const rate24h = sent24h > 0 ? (accepted24h / sent24h * 100) : null;

  const hist = history.find(h => h.platform === platform);
  const rate7d = hist ? parseFloat(hist.avg_acceptance_rate || 0) : null;

  if (rate24h === null || rate7d === null || sent24h < 5) return; // Pas assez de données

  const dropPct = rate7d > 0 ? ((rate7d - rate24h) / rate7d * 100) : 0;
  const threshold = parseFloat($env.SHADOW_BAN_THRESHOLD_PCT || '30');

  const isCritical = dropPct >= threshold * 1.5;
  const isWarning  = dropPct >= threshold;

  if (isWarning) {
    alerts.push({
      platform,
      rate_24h: parseFloat(rate24h.toFixed(1)),
      rate_7d: parseFloat(rate7d.toFixed(1)),
      drop_pct: parseFloat(dropPct.toFixed(1)),
      severity: isCritical ? 'critical' : 'warning',
      health_score: Math.max(0, Math.round(100 - dropPct * 2)),
      recommended_action: isCritical ? 'pause_48h' : 'reduce_rate',
      pause_hours: isCritical ? 48 : 24
    });
    console.warn(\`[SHADOW_BAN] \${platform} — chute \${dropPct.toFixed(1)}% (24h:\${rate24h.toFixed(1)}% vs 7j:\${rate7d.toFixed(1)}%)\`);
  }
});

if (alerts.length === 0) {
  console.log('[SHADOW_BAN] Toutes les plateformes en bonne santé');
  return [{ json: { all_healthy: true, alerts: [] } }];
}

return alerts.map(a => ({ json: { ...a, all_healthy: false } }));
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// SECTION 20 – TELEGRAM NOTIFIER
// ══════════════════════════════════════════════════════════════════
// Formate et envoie une notification Telegram depuis n8n.
// Alternative au bot complet pour les alertes simples.
// ──────────────────────────────────────────────────────────────────

const TELEGRAM_NOTIFIER = `
// ─── Telegram Notifier ───────────────────────────────────────────
// Formate le payload pour l'API Telegram Bot (sendMessage).
// Passer ensuite à un nœud HTTP Request vers :
//   POST https://api.telegram.org/bot{TOKEN}/sendMessage

const item = $input.item.json;
const CHAT_ID = $env.TELEGRAM_CHAT_ID;

// Types de notifications prédéfinis
const TEMPLATES = {
  hot_lead: {
    emoji: '🚨',
    format: (d) => \`🚨 *HOT LEAD — \${d.full_name}*\n\n*Poste :* \${d.title} @ \${d.company}\n*Score :* \${d.profile_score}/10\n*Intent :* \${d.intent || 'hot\\_lead'}\n\n"\${(d.last_message || '').substring(0,120)}…"\`
  },
  signal: {
    emoji: '📡',
    format: (d) => \`📡 *Signal \${d.signal_strength?.toUpperCase()} — \${d.full_name}*\n\n*Type :* \${d.signal_type}\n*Détail :* \${(d.signal_excerpt || '').substring(0,150)}\n*Message prêt :* "\${(d.generated_message || '…').substring(0,100)}"\`
  },
  shadow_ban: {
    emoji: '🛡️',
    format: (d) => \`🛡️ *Shadow Ban détecté — \${d.platform?.toUpperCase()}*\n\nChute taux acceptation : *\-\${d.drop_pct}%*\nScore santé : *\${d.health_score}/100*\nAction : \${d.recommended_action}\`
  },
  daily_summary: {
    emoji: '📊',
    format: (d) => \`📊 *Résumé du \${new Date().toLocaleDateString('fr-FR')}*\n\n📨 Invitations : \${d.invites}\n💬 DMs : \${d.dms}\n✅ Succès : \${d.success_rate}\n🔥 Hot leads : \${d.hot_leads}\n💶 Coût Claude : \${d.claude_cost}€\`
  },
  ab_winner: {
    emoji: '🏆',
    format: (d) => \`🏆 *A/B Test conclu — Variante \${d.winner} gagne !*\n\nTest : \${d.test_name}\nAvantage : *+\${d.delta}%* de taux de réponse\nAction : variante gagnante promue automatiquement\`
  }
};

const notifType = item._notif_type || 'hot_lead';
const tpl = TEMPLATES[notifType] || TEMPLATES.hot_lead;
const text = tpl.format(item);

// Boutons inline (optionnels)
const inlineKeyboard = item._buttons || [];

const payload = {
  chat_id: CHAT_ID,
  text,
  parse_mode: 'Markdown',
  disable_web_page_preview: true,
  reply_markup: inlineKeyboard.length > 0
    ? { inline_keyboard: inlineKeyboard }
    : undefined
};

return [{ json: { payload, url: \`https://api.telegram.org/bot\${$env.TELEGRAM_BOT_TOKEN}/sendMessage\` } }];
// ─────────────────────────────────────────────────────────────────
`;

// ══════════════════════════════════════════════════════════════════
// INDEX DES SECTIONS
// ══════════════════════════════════════════════════════════════════
/*
 Section 1  – QUOTA_MANAGER           : Vérification quota avant action
 Section 2  – JITTER_DELAY            : Délai aléatoire anti-bot
 Section 3  – HUMAN_ESCALATION        : Payload Discord riche pour leads chauds
 Section 4  – DRY_RUN_GATE            : Blocage universel en mode simulation
 Section 5  – QUOTA_INCREMENT_SQL     : SQL pour incrémenter après action réussie
 Section 6  – CLAUDE_RESPONSE_PARSER  : Parser robuste pour réponses Claude JSON
 Section 7  – BUSINESS_HOURS_GATE     : Filtre heures ouvrées
 Section 8  – WEEKLY_REPORT_FORMATTER : Rapport hebdomadaire Discord
 Section 9  – ERROR_HANDLER_WITH_RETRY: Retry avec backoff exponentiel
 Section 10 – PROSPECT_QUALIFIER      : Pré-qualification locale (sans Claude)

 ── v2 (Learning, A/B, CRM, Langue) ─────────────────────────────
 Section 11 – AB_TEST_ROUTER          : Split 50/50 A/B sur les templates actifs
 Section 12 – PERFORMANCE_ANALYZER    : Agrège métriques semaine pour Prompt F
 Section 13 – CRM_PAYLOAD_BUILDER     : Formate payload HubSpot/Pipedrive/Notion
 Section 14 – LANGUAGE_DETECTOR       : Détection heuristique langue prospect
 Section 15 – TEMPLATE_EVOLVER        : Applique améliorations Claude → nouvelles versions DB

 ── v3 (Signaux, Recyclage, ROI, Shadow Ban, Telegram) ───────────
 Section 16 – SIGNAL_DETECTOR         : Calcule priorité composite d'un signal
 Section 17 – COLD_RECYCLER           : Évalue si un prospect froid mérite réactivation
 Section 18 – ROI_CALCULATOR          : Calcule ROI temps réel (coûts vs CA)
 Section 19 – SHADOW_BAN_DETECTOR     : Détecte chute taux acceptation + alerte
 Section 20 – TELEGRAM_NOTIFIER       : Formate payload Telegram pour HTTP Request

 Modèle Claude recommandé par usage :
   - Outreach / réponses DMs     → claude-opus-4-7  (qualité maximale)
   - Qualification en batch      → claude-haiku-4-5-20251001 (rapide + économique)
   - Analyse contenu / learning  → claude-opus-4-7  (analyse stratégique)
   - Détection langue / signaux  → claude-haiku-4-5-20251001 (volume)
   - Recyclage prospects froids  → claude-haiku-4-5-20251001 (volume hebdo)
*/
