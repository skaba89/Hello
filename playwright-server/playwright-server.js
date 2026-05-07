'use strict';

/**
 * playwright-server.js
 * Serveur Express exposant les actions LinkedIn/Instagram via Playwright.
 * Toutes les requêtes sont authentifiées par clé API locale.
 */

const express = require('express');
const { chromium } = require('playwright');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const CONFIG = {
  port: parseInt(process.env.PORT || '3001', 10),
  apiKey: process.env.API_KEY,
  headless: process.env.HEADLESS !== 'false',
  sessionDir: process.env.SESSION_DIR || '/sessions',
  logDir: process.env.LOG_DIR || '/app/logs',
  linkedin: {
    email: process.env.LINKEDIN_EMAIL,
    password: process.env.LINKEDIN_PASSWORD,
    dailyInviteLimit: parseInt(process.env.LINKEDIN_DAILY_INVITE_LIMIT || '60', 10),
    minDelayMs: parseInt(process.env.LINKEDIN_MIN_DELAY_MS || '45000', 10),
    maxDelayMs: parseInt(process.env.LINKEDIN_MAX_DELAY_MS || '90000', 10),
  },
  instagram: {
    email: process.env.INSTAGRAM_EMAIL,
    password: process.env.INSTAGRAM_PASSWORD,
    dailyDmLimit: parseInt(process.env.INSTAGRAM_DAILY_DM_LIMIT || '30', 10),
    minDelayMs: parseInt(process.env.INSTAGRAM_MIN_DELAY_MS || '30000', 10),
  },
};

if (!CONFIG.apiKey) {
  console.error('FATAL: API_KEY env var is required');
  process.exit(1);
}

// ─────────────────────────────────────────────
// Logger Winston
// ─────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'playwright-server' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${level}] ${message} ${extras}`;
        })
      ),
    }),
    new DailyRotateFile({
      dirname: CONFIG.logDir,
      filename: 'playwright-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  ],
});

// ─────────────────────────────────────────────
// Compteurs quotidiens en mémoire (reset à minuit)
// ─────────────────────────────────────────────
const dailyCounters = {
  linkedin: { invites: 0, messages: 0, date: new Date().toDateString() },
  instagram: { dms: 0, date: new Date().toDateString() },
};

function checkAndResetCounters() {
  const today = new Date().toDateString();
  if (dailyCounters.linkedin.date !== today) {
    dailyCounters.linkedin = { invites: 0, messages: 0, date: today };
    logger.info('LinkedIn daily counters reset');
  }
  if (dailyCounters.instagram.date !== today) {
    dailyCounters.instagram = { dms: 0, date: today };
    logger.info('Instagram daily counters reset');
  }
}

// ─────────────────────────────────────────────
// Gestion des navigateurs (pool simple)
// ─────────────────────────────────────────────
const browsers = {
  linkedin: null,
  instagram: null,
};

const pages = {
  linkedin: null,
  instagram: null,
};

// Mutex simple pour éviter les actions concurrentes
const locks = {
  linkedin: false,
  instagram: false,
};

async function acquireLock(platform, timeoutMs = 60000) {
  const start = Date.now();
  while (locks[platform]) {
    if (Date.now() - start > timeoutMs) throw new Error(`Lock timeout for ${platform}`);
    await sleep(500);
  }
  locks[platform] = true;
}

function releaseLock(platform) {
  locks[platform] = false;
}

// ─────────────────────────────────────────────
// Utilitaires
// ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function humanDelay(platform = 'linkedin') {
  const min = CONFIG[platform]?.minDelayMs ?? 45000;
  const max = CONFIG[platform]?.maxDelayMs ?? 90000;
  const delay = jitter(min, max);
  logger.debug(`Human delay: ${delay}ms`, { platform });
  await sleep(delay);
}

async function typeHuman(page, selector, text) {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(jitter(50, 180));
  }
}

function getBrowserArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
  ];
}

// ─────────────────────────────────────────────
// Gestion des sessions persistantes
// ─────────────────────────────────────────────
function getSessionPath(platform) {
  return path.join(CONFIG.sessionDir, `${platform}-session`);
}

async function ensureSessionDir() {
  if (!fs.existsSync(CONFIG.sessionDir)) {
    fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
  }
}

// ─────────────────────────────────────────────
// LinkedIn – initialisation et login
// ─────────────────────────────────────────────
async function getLinkedInPage() {
  await ensureSessionDir();
  const sessionPath = getSessionPath('linkedin');

  if (!browsers.linkedin || !pages.linkedin) {
    logger.info('Launching LinkedIn browser');
    const context = await chromium.launchPersistentContext(sessionPath, {
      headless: CONFIG.headless,
      args: getBrowserArgs(),
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });

    browsers.linkedin = context;
    const existingPages = context.pages();
    pages.linkedin = existingPages.length > 0 ? existingPages[0] : await context.newPage();

    // Masquer les marqueurs d'automatisation
    await pages.linkedin.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });
  }

  const isLoggedIn = await checkLinkedInLogin();
  if (!isLoggedIn) {
    await loginLinkedIn();
  }

  return pages.linkedin;
}

async function checkLinkedInLogin() {
  try {
    await pages.linkedin.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const url = pages.linkedin.url();
    return url.includes('/feed') || url.includes('/in/');
  } catch {
    return false;
  }
}

async function loginLinkedIn() {
  logger.info('Logging in to LinkedIn');
  const page = pages.linkedin;

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });
  await sleep(jitter(1000, 2000));

  await typeHuman(page, '#username', CONFIG.linkedin.email);
  await sleep(jitter(500, 1200));
  await typeHuman(page, '#password', CONFIG.linkedin.password);
  await sleep(jitter(500, 1000));

  await page.click('[data-litms-control-urn="login-submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });

  const url = page.url();
  if (url.includes('/checkpoint/')) {
    throw new Error('LinkedIn security checkpoint – manual verification required');
  }
  if (!url.includes('/feed')) {
    throw new Error(`LinkedIn login failed, redirected to: ${url}`);
  }

  logger.info('LinkedIn login successful');
  await sleep(jitter(2000, 4000));
}

// ─────────────────────────────────────────────
// Instagram – initialisation et login
// ─────────────────────────────────────────────
async function getInstagramPage() {
  await ensureSessionDir();
  const sessionPath = getSessionPath('instagram');

  if (!browsers.instagram || !pages.instagram) {
    logger.info('Launching Instagram browser');
    const context = await chromium.launchPersistentContext(sessionPath, {
      headless: CONFIG.headless,
      args: getBrowserArgs(),
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });

    browsers.instagram = context;
    const existingPages = context.pages();
    pages.instagram = existingPages.length > 0 ? existingPages[0] : await context.newPage();
  }

  const isLoggedIn = await checkInstagramLogin();
  if (!isLoggedIn) {
    await loginInstagram();
  }

  return pages.instagram;
}

async function checkInstagramLogin() {
  try {
    await pages.instagram.goto('https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const url = pages.instagram.url();
    return !url.includes('/accounts/login');
  } catch {
    return false;
  }
}

async function loginInstagram() {
  logger.info('Logging in to Instagram');
  const page = pages.instagram;

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle' });
  await sleep(jitter(2000, 3000));

  // Accepter les cookies si demandé
  try {
    const cookieBtn = page.locator('text=Tout accepter').first();
    if (await cookieBtn.isVisible({ timeout: 3000 })) {
      await cookieBtn.click();
      await sleep(jitter(1000, 2000));
    }
  } catch {}

  await typeHuman(page, 'input[name="username"]', CONFIG.instagram.email);
  await sleep(jitter(500, 1200));
  await typeHuman(page, 'input[name="password"]', CONFIG.instagram.password);
  await sleep(jitter(500, 1000));

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });

  const url = page.url();
  if (url.includes('/challenge/') || url.includes('/accounts/login')) {
    throw new Error('Instagram login failed or requires verification');
  }

  logger.info('Instagram login successful');
  await sleep(jitter(2000, 4000));
}

// ─────────────────────────────────────────────
// Actions LinkedIn
// ─────────────────────────────────────────────

async function linkedInSendInvite({ profileUrl, message, requestId }) {
  checkAndResetCounters();
  if (dailyCounters.linkedin.invites >= CONFIG.linkedin.dailyInviteLimit) {
    throw new Error(`Daily LinkedIn invite limit reached (${CONFIG.linkedin.dailyInviteLimit})`);
  }

  await acquireLock('linkedin');
  try {
    const page = await getLinkedInPage();
    logger.info('Navigating to profile for invite', { profileUrl, requestId });

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(2000, 4000));

    // Chercher le bouton "Se connecter" ou "Connect"
    const connectBtn = page
      .locator(
        'button:has-text("Se connecter"), button:has-text("Connect"), button[aria-label*="Connect"], button[aria-label*="Inviter"]'
      )
      .first();

    if (!(await connectBtn.isVisible({ timeout: 5000 }))) {
      throw new Error('Connect button not found – already connected or profile not accessible');
    }

    await connectBtn.click();
    await sleep(jitter(1500, 3000));

    // Ajouter une note personnalisée si fournie
    if (message) {
      const addNoteBtn = page
        .locator('button:has-text("Ajouter une note"), button:has-text("Add a note")')
        .first();
      if (await addNoteBtn.isVisible({ timeout: 3000 })) {
        await addNoteBtn.click();
        await sleep(jitter(800, 1500));

        const textarea = page.locator('textarea[name="message"]').first();
        await textarea.clear();
        await typeHuman(page, 'textarea[name="message"]', message.slice(0, 300));
        await sleep(jitter(500, 1000));
      }
    }

    // Envoyer
    const sendBtn = page
      .locator('button:has-text("Envoyer"), button:has-text("Send"), button:has-text("Envoyer une invitation")')
      .first();
    await sendBtn.click();
    await page.waitForTimeout(2000);

    dailyCounters.linkedin.invites++;
    logger.info('LinkedIn invite sent', {
      profileUrl,
      requestId,
      dailyCount: dailyCounters.linkedin.invites,
    });

    await humanDelay('linkedin');
    return { success: true, dailyInvites: dailyCounters.linkedin.invites };
  } finally {
    releaseLock('linkedin');
  }
}

async function linkedInSendMessage({ profileUrl, conversationUrl, message, requestId }) {
  await acquireLock('linkedin');
  try {
    const page = await getLinkedInPage();

    // Si on a une URL de conversation directe, l'utiliser
    const targetUrl = conversationUrl || profileUrl;
    logger.info('Sending LinkedIn message', { targetUrl, requestId });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(2000, 3000));

    // Bouton "Message" sur le profil
    if (!conversationUrl) {
      const msgBtn = page
        .locator('button:has-text("Message"), button[aria-label*="Message"]')
        .first();
      if (await msgBtn.isVisible({ timeout: 5000 })) {
        await msgBtn.click();
        await sleep(jitter(1500, 2500));
      }
    }

    // Zone de texte du message
    const msgInput = page
      .locator(
        '.msg-form__contenteditable, [contenteditable="true"][aria-label*="message"], div[data-placeholder]'
      )
      .first();
    await msgInput.waitFor({ state: 'visible', timeout: 10000 });
    await msgInput.click();
    await sleep(jitter(500, 1000));

    // Vider et taper
    await msgInput.fill('');
    for (const char of message) {
      await page.keyboard.type(char);
      await sleep(jitter(30, 120));
    }
    await sleep(jitter(500, 1200));

    // Envoyer avec Entrée ou bouton
    await page.keyboard.press('Enter');
    await sleep(jitter(1000, 2000));

    dailyCounters.linkedin.messages++;
    logger.info('LinkedIn message sent', { requestId, dailyCount: dailyCounters.linkedin.messages });

    await humanDelay('linkedin');
    return { success: true, dailyMessages: dailyCounters.linkedin.messages };
  } finally {
    releaseLock('linkedin');
  }
}

async function linkedInReadDMs({ maxConversations = 10, requestId }) {
  await acquireLock('linkedin');
  try {
    const page = await getLinkedInPage();
    logger.info('Reading LinkedIn DMs', { requestId });

    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await sleep(jitter(2000, 3000));

    const conversations = [];

    // Récupérer les conversations dans la liste
    const convItems = await page
      .locator('.msg-conversation-listitem, [data-control-name="messenger_inbox_conversation_list_item"]')
      .all();

    const limit = Math.min(convItems.length, maxConversations);

    for (let i = 0; i < limit; i++) {
      try {
        await convItems[i].click();
        await sleep(jitter(1000, 2000));

        // Extraire les messages de la conversation active
        const senderName = await page
          .locator('.msg-entity-lockup__entity-title, .presence-entity__name')
          .first()
          .textContent()
          .catch(() => 'Unknown');

        const messages = await page.locator('.msg-s-message-list__event').all();
        const msgTexts = [];

        for (const msg of messages.slice(-5)) {
          const text = await msg.textContent().catch(() => '');
          const isOwn = await msg.locator('.msg-s-message-group--own').count() > 0;
          if (text.trim()) {
            msgTexts.push({ text: text.trim(), isOwn });
          }
        }

        conversations.push({
          senderName: senderName?.trim(),
          messages: msgTexts,
          url: page.url(),
        });
      } catch (err) {
        logger.warn('Error reading conversation', { index: i, error: err.message });
      }
    }

    logger.info('LinkedIn DMs read', { count: conversations.length, requestId });
    return { success: true, conversations };
  } finally {
    releaseLock('linkedin');
  }
}

// ─────────────────────────────────────────────
// Actions Instagram
// ─────────────────────────────────────────────

async function instagramSendDM({ username, message, requestId }) {
  checkAndResetCounters();
  if (dailyCounters.instagram.dms >= CONFIG.instagram.dailyDmLimit) {
    throw new Error(`Daily Instagram DM limit reached (${CONFIG.instagram.dailyDmLimit})`);
  }

  await acquireLock('instagram');
  try {
    const page = await getInstagramPage();
    logger.info('Sending Instagram DM', { username, requestId });

    // Ouvrir la messagerie directe
    await page.goto(`https://www.instagram.com/direct/new/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(2000, 3000));

    // Chercher l'utilisateur
    const searchInput = page.locator('input[placeholder*="Rechercher"], input[placeholder*="Search"]').first();
    await searchInput.fill(username);
    await sleep(jitter(1500, 2500));

    // Sélectionner le premier résultat
    const firstResult = page.locator('[role="option"]').first();
    await firstResult.waitFor({ state: 'visible', timeout: 10000 });
    await firstResult.click();
    await sleep(jitter(1000, 2000));

    // Confirmer la sélection
    const nextBtn = page.locator('button:has-text("Suivant"), button:has-text("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 })) {
      await nextBtn.click();
      await sleep(jitter(1500, 2500));
    }

    // Écrire le message
    const msgInput = page
      .locator('textarea[placeholder*="Message"], div[contenteditable="true"]')
      .first();
    await msgInput.waitFor({ state: 'visible', timeout: 10000 });
    await msgInput.click();

    for (const char of message) {
      await page.keyboard.type(char);
      await sleep(jitter(40, 130));
    }
    await sleep(jitter(500, 1200));

    // Envoyer
    const sendBtn = page.locator('button:has-text("Envoyer"), button[type="submit"]').first();
    if (await sendBtn.isVisible({ timeout: 3000 })) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await sleep(jitter(1000, 2000));

    dailyCounters.instagram.dms++;
    logger.info('Instagram DM sent', { username, requestId, dailyCount: dailyCounters.instagram.dms });

    await humanDelay('instagram');
    return { success: true, dailyDms: dailyCounters.instagram.dms };
  } finally {
    releaseLock('instagram');
  }
}

async function instagramReadDMs({ maxConversations = 10, requestId }) {
  await acquireLock('instagram');
  try {
    const page = await getInstagramPage();
    logger.info('Reading Instagram DMs', { requestId });

    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await sleep(jitter(2000, 3000));

    const conversations = [];
    const convItems = await page.locator('[role="listitem"]').all();
    const limit = Math.min(convItems.length, maxConversations);

    for (let i = 0; i < limit; i++) {
      try {
        await convItems[i].click();
        await sleep(jitter(1000, 2000));

        const messages = await page.locator('[role="row"]').all();
        const msgTexts = [];

        for (const msg of messages.slice(-5)) {
          const text = await msg.textContent().catch(() => '');
          if (text.trim()) msgTexts.push(text.trim());
        }

        conversations.push({ messages: msgTexts, url: page.url() });
      } catch (err) {
        logger.warn('Error reading Instagram conversation', { index: i, error: err.message });
      }
    }

    return { success: true, conversations };
  } finally {
    releaseLock('instagram');
  }
}

// ─────────────────────────────────────────────
// Express Application
// ─────────────────────────────────────────────
const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// Rate limiter global
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  })
);

// Middleware d'authentification
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== CONFIG.apiKey) {
    logger.warn('Unauthorized request', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware de logging des requêtes
app.use((req, res, next) => {
  const requestId = uuidv4().slice(0, 8);
  req.requestId = requestId;
  logger.info('Incoming request', { method: req.method, path: req.path, requestId });
  next();
});

// ─────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────

// Healthcheck (pas d'auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    counters: dailyCounters,
    timestamp: new Date().toISOString(),
  });
});

// Status détaillé (pas d'auth)
app.get('/status', (req, res) => {
  checkAndResetCounters();
  res.json({
    counters: dailyCounters,
    locks,
    limits: {
      linkedin: {
        dailyInviteLimit: CONFIG.linkedin.dailyInviteLimit,
        invitesRemaining: CONFIG.linkedin.dailyInviteLimit - dailyCounters.linkedin.invites,
      },
      instagram: {
        dailyDmLimit: CONFIG.instagram.dailyDmLimit,
        dmsRemaining: CONFIG.instagram.dailyDmLimit - dailyCounters.instagram.dms,
      },
    },
  });
});

// ─── LinkedIn ───
app.post('/linkedin/send-invite', authMiddleware, async (req, res) => {
  const { profileUrl, message } = req.body;
  if (!profileUrl) return res.status(400).json({ error: 'profileUrl required' });

  try {
    const result = await linkedInSendInvite({ profileUrl, message, requestId: req.requestId });
    res.json(result);
  } catch (err) {
    logger.error('Error sending LinkedIn invite', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

app.post('/linkedin/send-message', authMiddleware, async (req, res) => {
  const { profileUrl, conversationUrl, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!profileUrl && !conversationUrl)
    return res.status(400).json({ error: 'profileUrl or conversationUrl required' });

  try {
    const result = await linkedInSendMessage({
      profileUrl,
      conversationUrl,
      message,
      requestId: req.requestId,
    });
    res.json(result);
  } catch (err) {
    logger.error('Error sending LinkedIn message', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

app.get('/linkedin/read-dms', authMiddleware, async (req, res) => {
  const maxConversations = parseInt(req.query.max || '10', 10);
  try {
    const result = await linkedInReadDMs({ maxConversations, requestId: req.requestId });
    res.json(result);
  } catch (err) {
    logger.error('Error reading LinkedIn DMs', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

// ─── Instagram ───
app.post('/instagram/send-dm', authMiddleware, async (req, res) => {
  const { username, message } = req.body;
  if (!username || !message) return res.status(400).json({ error: 'username and message required' });

  try {
    const result = await instagramSendDM({ username, message, requestId: req.requestId });
    res.json(result);
  } catch (err) {
    logger.error('Error sending Instagram DM', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

app.get('/instagram/read-dms', authMiddleware, async (req, res) => {
  const maxConversations = parseInt(req.query.max || '10', 10);
  try {
    const result = await instagramReadDMs({ maxConversations, requestId: req.requestId });
    res.json(result);
  } catch (err) {
    logger.error('Error reading Instagram DMs', { error: err.message, requestId: req.requestId });
    res.status(500).json({ error: err.message });
  }
});

// ─── Gestion des sessions ───
app.post('/session/reset', authMiddleware, async (req, res) => {
  const { platform } = req.body;
  try {
    if (!platform || platform === 'linkedin') {
      if (browsers.linkedin) {
        await browsers.linkedin.close();
        browsers.linkedin = null;
        pages.linkedin = null;
      }
    }
    if (!platform || platform === 'instagram') {
      if (browsers.instagram) {
        await browsers.instagram.close();
        browsers.instagram = null;
        pages.instagram = null;
      }
    }
    logger.info('Session reset', { platform: platform || 'all' });
    res.json({ success: true, message: `Session(s) reset for: ${platform || 'all'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  logger.info(`Playwright server listening`, { port: CONFIG.port });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    if (browsers.linkedin) await browsers.linkedin.close().catch(() => {});
    if (browsers.instagram) await browsers.instagram.close().catch(() => {});
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
