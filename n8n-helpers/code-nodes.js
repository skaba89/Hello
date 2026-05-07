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

 Modèle Claude recommandé par usage :
   - Outreach / réponses DMs  → claude-opus-4-7 (qualité maximale)
   - Qualification en batch   → claude-haiku-4-5-20251001 (rapide + économique)
   - Analyse + contenu        → claude-sonnet-4-6 (équilibre)
*/
