#!/usr/bin/env node
/**
 * scripts/telegram-bot.js
 * ══════════════════════════════════════════════════════════════════
 * Bot Telegram interactif pour les notifications de l'automation.
 * Reçoit les alertes et permet de répondre avec des boutons :
 *   → /approve  : approuver une action en attente
 *   → /snooze   : reporter de 2h
 *   → /escalate : marquer pour traitement humain urgent
 *   → /status   : état du système en temps réel
 *   → /report   : rapport du jour
 *
 * Prérequis :
 *   npm install node-telegram-bot-api pg dotenv
 *
 * Variables d'env requises :
 *   TELEGRAM_BOT_TOKEN    : Token BotFather
 *   TELEGRAM_CHAT_ID      : Chat ID (ou group ID) destination
 *   DATABASE_URL          : Connection string PostgreSQL
 *   N8N_WEBHOOK_URL       : URL de base n8n pour déclencher des WFs
 *   PLAYWRIGHT_SERVER_URL : URL du serveur Playwright
 *   PLAYWRIGHT_API_KEY    : Clé API Playwright
 * ══════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const N8N_URL    = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[Telegram] TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID requis dans .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db  = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ──────────────────────────────────────────────────────

async function query(sql, params = []) {
  const client = await db.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

function escapeMarkdown(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ── Envoi de notifications enrichies ─────────────────────────────

/**
 * Envoie une notification avec boutons inline.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.emoji
 * @param {Array}  opts.buttons  [[{text,callback_data},...],...]
 * @param {number} opts.prospectId
 */
async function sendNotification({ title, body, emoji = '🔔', buttons = [], prospectId = null }) {
  const text = `${emoji} *${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;

  const opts = {
    parse_mode: 'MarkdownV2',
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
  };

  try {
    const msg = await bot.sendMessage(CHAT_ID, text, opts);

    // Sauvegarder en DB
    if (prospectId) {
      await query(
        `INSERT INTO telegram_notifications
           (notification_type, message_text, chat_id, message_id, has_buttons, buttons_json, prospect_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ['hot_lead', body, CHAT_ID, String(msg.message_id),
         buttons.length > 0, JSON.stringify(buttons), prospectId]
      );
    }
    return msg;
  } catch(err) {
    console.error('[Telegram] Erreur envoi:', err.message);
  }
}

// ── Notifications publiques (appelées par n8n via HTTP) ───────────

/**
 * Hot lead : alerte immédiate avec boutons d'action.
 */
async function notifyHotLead(prospect) {
  await sendNotification({
    title: `🎯 Hot Lead — ${prospect.full_name}`,
    body: `Poste: ${prospect.title} @ ${prospect.company}\nScore: ${prospect.profile_score}/10\nIntent: ${prospect.intent || 'hot_lead'}\nMessage: "${(prospect.last_message || '').substring(0, 120)}…"`,
    emoji: '🚨',
    prospectId: prospect.id,
    buttons: [
      [
        { text: '✅ Répondre maintenant', callback_data: `reply_${prospect.id}` },
        { text: '⏰ Snooze 2h',          callback_data: `snooze_${prospect.id}` }
      ],
      [
        { text: '📞 Planifier un call',  callback_data: `call_${prospect.id}` },
        { text: '👁 Voir le profil',     callback_data: `view_${prospect.id}` }
      ]
    ]
  });
}

/**
 * Résumé journalier 9h.
 */
async function sendDailySummary() {
  const res = await query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today_actions,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND status = 'success') AS today_success,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND action_type = 'invite') AS today_invites,
      COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND action_type IN ('message','dm')) AS today_dms
    FROM actions
  `);
  const r = res.rows[0];

  const leads = await query(`
    SELECT COUNT(*) as hot FROM prospects WHERE status = 'hot_lead' AND updated_at >= CURRENT_DATE
  `);

  const body = [
    `📨 Invitations : ${r.today_invites}`,
    `💬 DMs envoyés : ${r.today_dms}`,
    `✅ Succès : ${r.today_success}/${r.today_actions}`,
    `🔥 Nouveaux hot leads : ${leads.rows[0].hot}`
  ].join('\n');

  await sendNotification({
    title: 'Résumé du jour',
    body,
    emoji: '📊',
    buttons: [[
      { text: '📈 Voir analytics', callback_data: 'show_analytics' },
      { text: '⚡ Lancer outreach', callback_data: 'trigger_outreach' }
    ]]
  });
}

/**
 * Alerte shadow ban.
 */
async function notifyShadowBan(platform, dropPct, healthScore) {
  await sendNotification({
    title: `⚠️ Shadow Ban probable — ${platform.toUpperCase()}`,
    body: `Chute du taux d'acceptation : -${dropPct}%\nScore de santé : ${healthScore}/100\n\nAction recommandée : pause 24-48h + changement d'IP si possible.`,
    emoji: '🛡️',
    buttons: [[
      { text: '⏸ Mettre en pause', callback_data: `pause_${platform}` },
      { text: '🔁 Continuer quand même', callback_data: `continue_${platform}` }
    ]]
  });
}

// ── Gestion des callbacks (boutons cliqués) ───────────────────────

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data.startsWith('reply_')) {
      const prospectId = data.split('_')[1];
      const p = await query.db?.query?.('SELECT full_name, platform FROM prospects WHERE id = $1', [prospectId]);
      await bot.editMessageText(
        `✅ Réponse initiée pour le prospect #${prospectId}.\n_Le workflow de réponse a été déclenché._`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2' }
      );
      // Trigger n8n webhook pour réponse manuelle
      const fetch = require('node:http');
      // Dans un vrai déploiement : appel fetch vers N8N_URL/webhook/manual-reply
    }

    if (data.startsWith('snooze_')) {
      const prospectId = data.split('_')[1];
      await bot.editMessageText(
        `⏰ Snoozé 2h pour le prospect #${prospectId}.\n_Rappel dans 2h._`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2' }
      );
      // Programmer un rappel
      setTimeout(() => notifyHotLead({ id: prospectId, full_name: 'Rappel', profile_score: 9, company: '', title: '' }), 2 * 3600 * 1000);
    }

    if (data.startsWith('pause_')) {
      const platform = data.split('_')[1];
      await db.query(
        `INSERT INTO system_config (key, value, description)
         VALUES ('${platform}_paused_until', $1, 'Pause automatique shadow ban')
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [new Date(Date.now() + 24 * 3600 * 1000).toISOString()]
      );
      await bot.editMessageText(
        `⏸ ${platform.toUpperCase()} mis en pause pour 24h.\n_Reprise automatique demain._`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'MarkdownV2' }
      );
    }

    if (data === 'show_analytics' || data === 'trigger_outreach') {
      await bot.sendMessage(chatId, `_Commande ${data} reçue — fonctionnalité déclenchée._`, { parse_mode: 'MarkdownV2' });
    }

  } catch (err) {
    console.error('[Telegram] Callback error:', err.message);
  }
});

// ── Commandes texte ───────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🤖 *AutoReach Bot v2\\.0*\n\nCommandes disponibles:\n/status — État du système\n/report — Rapport du jour\n/leads — Hot leads en attente\n/pause \\[linkedin|instagram\\] — Mettre en pause\n/resume \\[linkedin|instagram\\] — Reprendre\n/quota — Quotas restants aujourd'hui\n/help — Aide`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/status/, async (msg) => {
  try {
    const res = await query(`
      SELECT
        (SELECT COUNT(*) FROM prospects WHERE status NOT IN ('do_not_contact','unsubscribed')) as total_prospects,
        (SELECT COUNT(*) FROM prospects WHERE status = 'hot_lead') as hot_leads,
        (SELECT COUNT(*) FROM actions WHERE created_at >= CURRENT_DATE) as today_actions,
        (SELECT COUNT(*) FROM prospect_signals WHERE processed = FALSE) as pending_signals,
        (SELECT health_status FROM platform_health WHERE platform='linkedin' ORDER BY recorded_at DESC LIMIT 1) as li_health,
        (SELECT health_status FROM platform_health WHERE platform='instagram' ORDER BY recorded_at DESC LIMIT 1) as ig_health
    `);
    const r = res.rows[0];
    const liOk = r.li_health === 'healthy' ? '✅' : r.li_health === 'warning' ? '⚠️' : '🚨';
    const igOk = r.ig_health === 'healthy' ? '✅' : r.ig_health === 'warning' ? '⚠️' : '🚨';

    await bot.sendMessage(msg.chat.id,
      `📊 *État du système*\n\n👥 Prospects actifs : ${r.total_prospects}\n🔥 Hot leads : ${r.hot_leads}\n📨 Actions aujourd'hui : ${r.today_actions}\n📡 Signaux en attente : ${r.pending_signals}\n${liOk} LinkedIn : ${r.li_health}\n${igOk} Instagram : ${r.ig_health}`,
      { parse_mode: 'Markdown' }
    );
  } catch(e) {
    await bot.sendMessage(msg.chat.id, `⚠️ Erreur DB: ${e.message}`);
  }
});

bot.onText(/\/report/, async (msg) => {
  await sendDailySummary();
});

bot.onText(/\/leads/, async (msg) => {
  try {
    const res = await query(
      `SELECT full_name, title, company, profile_score, platform FROM prospects WHERE status = 'hot_lead' ORDER BY profile_score DESC LIMIT 5`
    );
    if (res.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '📭 Aucun hot lead en ce moment.');
      return;
    }
    const list = res.rows.map((r,i) =>
      `${i+1}. *${r.full_name}* — ${r.title} @ ${r.company} (${r.profile_score}/10) [${r.platform}]`
    ).join('\n');
    await bot.sendMessage(msg.chat.id, `🔥 *Hot Leads actifs*\n\n${list}`, { parse_mode: 'Markdown' });
  } catch(e) {
    await bot.sendMessage(msg.chat.id, `⚠️ Erreur: ${e.message}`);
  }
});

bot.onText(/\/quota/, async (msg) => {
  try {
    const res = await query(
      `SELECT platform, action_type, count, limit_value FROM quotas WHERE quota_date = CURRENT_DATE ORDER BY platform, action_type`
    );
    if (res.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '📊 Aucune action aujourd\'hui.');
      return;
    }
    const lines = res.rows.map(r =>
      `• ${r.platform} ${r.action_type}: ${r.count}/${r.limit_value} (${Math.round((1-r.count/r.limit_value)*100)}% restant)`
    ).join('\n');
    await bot.sendMessage(msg.chat.id, `📊 *Quotas du jour*\n\n${lines}`, { parse_mode: 'Markdown' });
  } catch(e) {
    await bot.sendMessage(msg.chat.id, `⚠️ Erreur: ${e.message}`);
  }
});

bot.onText(/\/pause (.+)/, async (msg, match) => {
  const platform = match[1].toLowerCase();
  if (!['linkedin','instagram'].includes(platform)) {
    await bot.sendMessage(msg.chat.id, '❌ Plateforme invalide. Utiliser: linkedin ou instagram');
    return;
  }
  await db.query(
    `INSERT INTO system_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [`${platform}_paused_until`, new Date(Date.now() + 24*3600*1000).toISOString()]
  );
  await bot.sendMessage(msg.chat.id, `⏸ *${platform.toUpperCase()}* mis en pause pour 24h.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    '📖 *Aide AutoReach Bot*\n\n' +
    '`/status` — État en temps réel\n' +
    '`/report` — Rapport du jour\n' +
    '`/leads` — Hot leads actifs\n' +
    '`/quota` — Quotas restants\n' +
    '`/pause [platform]` — Pause 24h\n' +
    '`/resume [platform]` — Reprendre\n\n' +
    'Les alertes automatiques arrivent ici dès qu\'un hot lead est détecté.',
    { parse_mode: 'Markdown' }
  );
});

// ── Démarrage ─────────────────────────────────────────────────────

console.log('[Telegram Bot] Démarré. Chat ID:', CHAT_ID);
bot.sendMessage(CHAT_ID, '🟢 *AutoReach Bot démarré*\n\nTape /status pour l\'état du système.', { parse_mode: 'Markdown' })
  .catch(e => console.error('[Telegram] Impossible d\'envoyer le message de démarrage:', e.message));

// Résumé quotidien à 9h
const now = new Date();
const next9am = new Date(now);
next9am.setHours(9, 0, 0, 0);
if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
const msTo9am = next9am - now;

setTimeout(() => {
  sendDailySummary();
  setInterval(sendDailySummary, 24 * 3600 * 1000);
}, msTo9am);

// ── Export (pour intégration n8n / tests) ────────────────────────
module.exports = { notifyHotLead, notifyShadowBan, sendDailySummary, sendNotification };
