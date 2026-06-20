const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');
const https   = require('https');
const fs      = require('fs');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  WHERE TO PUT YOUR TWELVE DATA API KEY
//  ───────────────────────────────────────
//  Option A (Railway / any cloud host — RECOMMENDED):
//    Add an environment variable named  TWELVEDATA_KEY  with your key value.
//    Example in Railway: Settings → Variables → New Variable
//      Name:  TWELVEDATA_KEY
//      Value: your_actual_key_here
//
//  Option B (local development):
//    Create a file called  .env  in the same folder as this file and add:
//      TWELVEDATA_KEY=your_actual_key_here
//    Then run:  npm install dotenv  and add  require('dotenv').config();  at
//    the very top of this file (before any other code).
//
//  Get a FREE key at: https://twelvedata.com
//    Sign up → Dashboard → API Keys → copy the key
//    Free tier: 800 API requests/day, 8 requests/minute
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN MANAGEMENT SYSTEM — persistent users / settings / audit log
// ═══════════════════════════════════════════════════════════════════════════
const DATA_DIR      = path.join(__dirname, 'data');
const USERS_FILE     = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const AUDIT_FILE     = path.join(DATA_DIR, 'audit-log.json');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const TRADES_FILE    = path.join(DATA_DIR, 'trades.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureFile(file, defaultContent) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultContent, null, 2));
}

// Migrate from the original hardcoded USERS array on first run.
// Original roles were 'admin' / 'user' — 'user' maps to 'write' by default
// so existing trader accounts keep their ability to view + use the dashboard
// exactly as before. Admin can downgrade anyone to 'read' afterwards.
ensureFile(USERS_FILE, [
  { id: 1, username: 'anil',    name: 'Anil',     email: '', role: 'admin', createdAt: new Date().toISOString(), createdBy: 'system' },
  { id: 2, username: 'trader2', name: 'Trader 2', email: '', role: 'write', createdAt: new Date().toISOString(), createdBy: 'system' },
  { id: 3, username: 'trader3', name: 'Trader 3', email: '', role: 'write', createdAt: new Date().toISOString(), createdBy: 'system' },
]);
ensureFile(SETTINGS_FILE, {
  signalStorageThreshold: 90,
  emailAlertThreshold: 90,
  updatedAt: new Date().toISOString(),
  updatedBy: 'system'
});
ensureFile(AUDIT_FILE, []);
ensureFile(PORTFOLIO_FILE, {
  startingBalance: 50000,
  currentBalance: 50000,
  riskPerTradePercent: 1,
  tradeStorageThreshold: 80,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updatedBy: 'system'
});
ensureFile(TRADES_FILE, []);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`[Data] Failed to read ${file}:`, e.message); return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; }
  catch (e) { console.error(`[Data] Failed to write ${file}:`, e.message); return false; }
}
function getUsers()     { return readJSON(USERS_FILE, []); }
function setUsers(u)    { return writeJSON(USERS_FILE, u); }
function getSettings()  { return readJSON(SETTINGS_FILE, { signalStorageThreshold: 90, emailAlertThreshold: 90 }); }
function setSettings(s) { return writeJSON(SETTINGS_FILE, s); }
function getAudit()     { return readJSON(AUDIT_FILE, []); }
function getPortfolio() {
  return readJSON(PORTFOLIO_FILE, {
    startingBalance: 50000, currentBalance: 50000,
    riskPerTradePercent: 1, tradeStorageThreshold: 80
  });
}
function setPortfolio(p) { return writeJSON(PORTFOLIO_FILE, p); }
function getTrades()     { return readJSON(TRADES_FILE, []); }
function setTrades(t)    { return writeJSON(TRADES_FILE, t); }
function appendAudit(entry) {
  const log = getAudit();
  log.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), timestamp: new Date().toISOString(), ...entry });
  if (log.length > 2000) log.length = 2000;
  writeJSON(AUDIT_FILE, log);
}

const ROLES = ['admin', 'write', 'read'];
function isValidRole(r) { return ROLES.includes(r); }

// ── PASSWORDS — still env-var based, exactly as in the original file ─────────
// Each user's password comes from PASS_<USERNAME_UPPERCASE>, falling back to
// the original 3 defaults for the original 3 accounts. New users created via
// the admin panel need their own PASS_<USERNAME> env var set on the server
// before they can log in — there is no plaintext password storage anywhere.
const FALLBACK_PASSWORDS = {
  anil:    'dhitta@2024',
  trader2: 'signals@123',
  trader3: 'dhitta@456'
};
function getPasswordFor(username) {
  const envKey = 'PASS_' + username.toUpperCase();
  return process.env[envKey] || FALLBACK_PASSWORDS[username.toLowerCase()] || null;
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(bufA, bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dhitta-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: false }
}));

app.use('/earth-bg.jpg', express.static(path.join(__dirname, 'public', 'earth-bg.jpg')));

// ── AUTH ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Forbidden — admin access required' });
}

// ── LOGIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?error=missing');

  const users = getUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
  if (!user) {
    console.log(`[Auth] Failed: "${username}" (no such user)`);
    return res.redirect('/login?error=invalid');
  }

  const realPassword = getPasswordFor(user.username);
  if (!realPassword || !safeCompare(password, realPassword)) {
    console.log(`[Auth] Failed: "${username}" (bad password)`);
    return res.redirect('/login?error=invalid');
  }

  req.session.userId      = user.id;
  req.session.username    = user.username;
  req.session.displayName = user.name;
  req.session.role        = user.role;
  console.log(`[Auth] ✅ Login: ${user.username} (${user.role})`);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username:    req.session.username,
    displayName: req.session.displayName,
    role:        req.session.role
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { resolve(data); });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── CANDLE CACHE (5-minute TTL) ───────────────────────────────────────────────
const candleCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── LIVE CANDLE FETCH — TWELVE DATA ──────────────────────────────────────────
async function fetchTwelveDataCandles(symbol) {
  const key = process.env.TWELVEDATA_KEY;
  if (!key) throw new Error('TWELVEDATA_KEY environment variable not set');

  const cached = candleCache[symbol];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    console.log(`[TwelveData] Cache hit for ${symbol}`);
    return cached.candles;
  }

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&outputsize=60&format=JSON&apikey=${key}`;
  console.log(`[TwelveData] Fetching ${symbol}...`);

  const data = await httpsGet(url);

  if (data.status === 'error' || !data.values || !data.values.length) {
    const msg = data.message || data.code || 'Unknown error';
    throw new Error(`Twelve Data error for ${symbol}: ${msg}`);
  }

  const candles = data.values
    .reverse()
    .map(v => ({
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      t: v.datetime
    }));

  candleCache[symbol] = { ts: Date.now(), candles };
  console.log(`[TwelveData] ✅ ${symbol}: ${candles.length} candles, latest close: ${candles[candles.length-1].c}`);

  return candles;
}

// ── /api/candles ENDPOINT ─────────────────────────────────────────────────────
const ALLOWED_SYMBOLS = new Set(['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD']);

app.get('/api/candles', requireAuth, async (req, res) => {
  const symbol = req.query.symbol;

  if (!symbol || !ALLOWED_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: `Invalid symbol. Allowed: ${[...ALLOWED_SYMBOLS].join(', ')}` });
  }

  if (!process.env.TWELVEDATA_KEY) {
    return res.status(503).json({
      error: 'TWELVEDATA_KEY not configured on server. Add it as an environment variable.',
      hint:  'Railway: Settings → Variables → TWELVEDATA_KEY = your_key'
    });
  }

  try {
    const candles = await fetchTwelveDataCandles(symbol);
    res.json({ symbol, candles, count: candles.length, source: 'Twelve Data' });
  } catch (e) {
    console.error(`[/api/candles] Error for ${symbol}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── AI PROXY (Gemini) ─────────────────────────────────────────────────────────
app.post('/api/ai', requireAuth, (req, res) => {
  const { prompt } = req.body;
  const GEMINI_KEY = process.env.GEMINI_KEY || '';
  if (!GEMINI_KEY) return res.status(503).json({ error: 'No Gemini key configured' });

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        const d = JSON.parse(data);
        if (d.error) return res.status(500).json({ error: d.error.message });
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
        res.json({ text });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  });
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── EMAIL PROXY (EmailJS) ─────────────────────────────────────────────────────
// NOTE: email sending itself is still triggered by the frontend's confidence
// check against EMAIL_ALERT_THRESHOLD (loaded from /api/settings). This route
// just relays the already-decided alert to EmailJS — no threshold logic here.
app.post('/api/send-email', requireAuth, async (req, res) => {
  const { pair, signal, confidence, score, istTime, message } = req.body;
  const EJS_SID    = process.env.EJS_SID    || '';
  const EJS_TID    = process.env.EJS_TID    || '';
  const EJS_PUB    = process.env.EJS_PUB    || '';
  const EMAIL_ADDR = process.env.EMAIL_ADDR || '';

  if (!EJS_SID || !EJS_TID || !EJS_PUB || !EMAIL_ADDR) {
    return res.json({ ok: false, reason: 'Email not configured on server' });
  }

  const body = {
    service_id:  EJS_SID,
    template_id: EJS_TID,
    user_id:     EJS_PUB,
    template_params: {
      to_email:   EMAIL_ADDR,
      pair, signal,
      confidence: confidence + '%',
      score:      score + '/100',
      ist_time:   istTime,
      message
    }
  };

  try {
    const result = await httpsPost('api.emailjs.com', '/api/v1.0/email/send', body);
    console.log('[Email] Result:', result);
    res.json({ ok: result === 'OK' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    hasGemini:      !!process.env.GEMINI_KEY,
    hasTwelveData:  !!process.env.TWELVEDATA_KEY,
    hasEmail:       !!(process.env.EJS_SID && process.env.EJS_TID && process.env.EJS_PUB),
    emailAddr:      process.env.EMAIL_ADDR || '',
    user: { name: req.session.displayName, role: req.session.role }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── SETTINGS (thresholds) ── read: any logged-in user · write: admin only
app.get('/api/settings', requireAuth, (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const { signalStorageThreshold, emailAlertThreshold } = req.body;
  const validValues = [60, 65, 70, 75, 80, 85, 90, 95];
  const current = getSettings();
  const next = { ...current };

  if (signalStorageThreshold !== undefined) {
    if (!validValues.includes(Number(signalStorageThreshold))) {
      return res.status(400).json({ error: 'signalStorageThreshold must be one of 60, 65, 70, 75, 80, 85, 90, 95' });
    }
    if (Number(signalStorageThreshold) !== current.signalStorageThreshold) {
      appendAudit({ type: 'threshold_change', actor: req.session.username,
        detail: `Signal Storage Threshold changed from ${current.signalStorageThreshold}% to ${signalStorageThreshold}%` });
    }
    next.signalStorageThreshold = Number(signalStorageThreshold);
  }

  if (emailAlertThreshold !== undefined) {
    if (!validValues.includes(Number(emailAlertThreshold))) {
      return res.status(400).json({ error: 'emailAlertThreshold must be one of 60, 65, 70, 75, 80, 85, 90, 95' });
    }
    if (Number(emailAlertThreshold) !== current.emailAlertThreshold) {
      appendAudit({ type: 'threshold_change', actor: req.session.username,
        detail: `Email Alert Threshold changed from ${current.emailAlertThreshold}% to ${emailAlertThreshold}%` });
    }
    next.emailAlertThreshold = Number(emailAlertThreshold);
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = req.session.username;
  if (!setSettings(next)) return res.status(500).json({ error: 'Failed to save settings' });
  res.json(next);
});

// ── USER MANAGEMENT — admin only ──────────────────────────────────────────
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = getUsers().map(u => ({
    id: u.id, username: u.username, name: u.name, email: u.email,
    role: u.role, createdAt: u.createdAt, createdBy: u.createdBy
  }));
  res.json(users);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, name, email, role } = req.body;
  if (!username || !name || !role) return res.status(400).json({ error: 'username, name, and role are required' });
  if (!isValidRole(role)) return res.status(400).json({ error: 'role must be one of: admin, write, read' });

  const users = getUsers();
  const cleanUsername = String(username).trim().toLowerCase();
  if (users.some(u => u.username.toLowerCase() === cleanUsername)) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const newId = users.length ? Math.max(...users.map(u => u.id)) + 1 : 1;
  const newUser = {
    id: newId, username: cleanUsername, name: String(name).trim(),
    email: email ? String(email).trim() : '', role,
    createdAt: new Date().toISOString(), createdBy: req.session.username
  };

  users.push(newUser);
  if (!setUsers(users)) return res.status(500).json({ error: 'Failed to save user' });

  appendAudit({ type: 'user_created', actor: req.session.username,
    detail: `Created user "${newUser.username}" (${newUser.name}) with role "${newUser.role}"` });

  res.status(201).json({
    user: newUser,
    note: `User created. Set environment variable PASS_${newUser.username.toUpperCase()} on the server with their password before they can log in.`
  });
});

app.patch('/api/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body;
  if (!isValidRole(role)) return res.status(400).json({ error: 'role must be one of: admin, write, read' });

  const users = getUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === role) return res.json({ user: u, changed: false });

  const oldRole = u.role;
  u.role = role;
  if (!setUsers(users)) return res.status(500).json({ error: 'Failed to save user' });

  appendAudit({ type: 'role_change', actor: req.session.username,
    detail: `Changed role of "${u.username}" from "${oldRole}" to "${role}"` });

  res.json({ user: u, changed: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const users = getUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.username === req.session.username) {
    return res.status(400).json({ error: 'You cannot delete your own account while logged in as it' });
  }

  const remaining = users.filter(x => x.id !== id);
  if (!setUsers(remaining)) return res.status(500).json({ error: 'Failed to save users' });

  appendAudit({ type: 'user_deleted', actor: req.session.username,
    detail: `Deleted user "${u.username}" (${u.name}, role: ${u.role})` });

  res.json({ deleted: true, id });
});

// ── AUDIT LOG — admin only ─────────────────────────────────────────────────
app.get('/api/audit-log', requireAuth, requireAdmin, (req, res) => {
  res.json(getAudit());
});

app.delete('/api/audit-log', requireAuth, requireAdmin, (req, res) => {
  const countBefore = getAudit().length;
  writeJSON(AUDIT_FILE, []);
  appendAudit({ type: 'log_deletion', actor: req.session.username,
    detail: `Cleared audit log (${countBefore} entries removed)` });
  res.json({ cleared: true, countBefore });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PORTFOLIO & TRADE TRACKING
//  Shared server-side state — same balance/trades for every logged-in user,
//  since this is paper-trading performance tracking, not per-browser data.
// ═══════════════════════════════════════════════════════════════════════════

// ── PORTFOLIO ── read: any logged-in user · write: admin only
app.get('/api/portfolio', requireAuth, (req, res) => {
  res.json(getPortfolio());
});

app.post('/api/portfolio/settings', requireAuth, requireAdmin, (req, res) => {
  const { riskPerTradePercent, tradeStorageThreshold, startingBalance } = req.body;
  const validThresholds = [60, 65, 70, 75, 80, 85, 90, 95];
  const current = getPortfolio();
  const next = { ...current };

  if (riskPerTradePercent !== undefined) {
    const r = Number(riskPerTradePercent);
    if (!(r > 0 && r <= 100)) return res.status(400).json({ error: 'riskPerTradePercent must be between 0 and 100' });
    if (r !== current.riskPerTradePercent) {
      appendAudit({ type: 'threshold_change', actor: req.session.username,
        detail: `Risk Per Trade changed from ${current.riskPerTradePercent}% to ${r}%` });
    }
    next.riskPerTradePercent = r;
  }

  if (tradeStorageThreshold !== undefined) {
    if (!validThresholds.includes(Number(tradeStorageThreshold))) {
      return res.status(400).json({ error: 'tradeStorageThreshold must be one of 60, 65, 70, 75, 80, 85, 90, 95' });
    }
    if (Number(tradeStorageThreshold) !== current.tradeStorageThreshold) {
      appendAudit({ type: 'threshold_change', actor: req.session.username,
        detail: `Trade Storage Threshold changed from ${current.tradeStorageThreshold}% to ${tradeStorageThreshold}%` });
    }
    next.tradeStorageThreshold = Number(tradeStorageThreshold);
  }

  // Resetting starting balance also resets current balance — admin-only,
  // explicit action since it wipes the "Today's P&L / Total P&L" baseline.
  if (startingBalance !== undefined) {
    const b = Number(startingBalance);
    if (!(b > 0)) return res.status(400).json({ error: 'startingBalance must be a positive number' });
    appendAudit({ type: 'threshold_change', actor: req.session.username,
      detail: `Portfolio reset — Starting Balance set to ₹${b} (was ₹${current.startingBalance})` });
    next.startingBalance = b;
    next.currentBalance  = b;
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = req.session.username;
  if (!setPortfolio(next)) return res.status(500).json({ error: 'Failed to save portfolio settings' });
  res.json(next);
});

// ── TRADES ── read: any logged-in user · create/resolve: write or admin · delete: admin only
app.get('/api/trades', requireAuth, (req, res) => {
  res.json(getTrades());
});

// Create a new OPEN trade. Called by the client the moment a signal crosses
// the Trade Storage Threshold (default 80%, separate from Signal Storage
// Threshold). Trade amount is computed server-side from current balance and
// riskPerTradePercent so the math can never be spoofed by the client.
app.post('/api/trades', requireAuth, (req, res) => {
  if (req.session.role === 'read') return res.status(403).json({ error: 'Read-only accounts cannot create trades' });

  const { pair, direction, confidence, entryPrice, session: sessionName } = req.body;
  if (!pair || !direction || confidence === undefined || entryPrice === undefined) {
    return res.status(400).json({ error: 'pair, direction, confidence, and entryPrice are required' });
  }
  if (!['BUY', 'SELL'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be BUY or SELL' });
  }

  const portfolio = getPortfolio();
  const tradeAmount = Math.round(portfolio.currentBalance * (portfolio.riskPerTradePercent / 100) * 100) / 100;

  const trades = getTrades();
  const trade = {
    id: 'T' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    pair: String(pair),
    direction,
    confidence: Number(confidence),
    entryPrice: Number(entryPrice),
    exitPrice: null,
    entryTime: new Date().toISOString(),
    exitTime: null,
    session: sessionName || '',
    tradeAmount,
    profitLoss: 0,
    status: 'OPEN',
    createdBy: req.session.username
  };

  trades.unshift(trade);
  if (trades.length > 5000) trades.length = 5000; // cap for free-tier storage
  if (!setTrades(trades)) return res.status(500).json({ error: 'Failed to save trade' });

  res.status(201).json(trade);
});

// Resolve an OPEN trade to WIN or LOSS. Called by the client ~5 min after
// entry (same expiry window the signal engine already uses), passing the
// real exit price it already fetched from Twelve Data. This route does the
// WIN/LOSS math and updates the portfolio balance — server-side, atomically,
// so the balance can't drift even if multiple users have the tab open.
app.post('/api/trades/:id/resolve', requireAuth, (req, res) => {
  if (req.session.role === 'read') return res.status(403).json({ error: 'Read-only accounts cannot resolve trades' });

  const { exitPrice } = req.body;
  if (exitPrice === undefined) return res.status(400).json({ error: 'exitPrice is required' });

  const trades = getTrades();
  const trade = trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.status !== 'OPEN') return res.json({ trade, alreadyResolved: true });

  const exit = Number(exitPrice);
  const won = (trade.direction === 'BUY'  && exit > trade.entryPrice) ||
              (trade.direction === 'SELL' && exit < trade.entryPrice);

  // Simple binary payout model: win returns +85% of stake, loss forfeits the stake.
  // (85% is a typical binary-options payout rate; this is paper-trading math only —
  // no real broker is involved, per the SAFETY requirement.)
  const profitLoss = won ? Math.round(trade.tradeAmount * 0.85 * 100) / 100
                          : -trade.tradeAmount;

  trade.exitPrice  = exit;
  trade.exitTime   = new Date().toISOString();
  trade.status     = won ? 'WIN' : 'LOSS';
  trade.profitLoss = profitLoss;

  if (!setTrades(trades)) return res.status(500).json({ error: 'Failed to save trade resolution' });

  const portfolio = getPortfolio();
  portfolio.currentBalance = Math.round((portfolio.currentBalance + profitLoss) * 100) / 100;
  portfolio.updatedAt = new Date().toISOString();
  portfolio.updatedBy = req.session.username;
  setPortfolio(portfolio);

  res.json({ trade, portfolio });
});

// Delete a trade record — admin only (mirrors audit-log deletion pattern)
app.delete('/api/trades/:id', requireAuth, requireAdmin, (req, res) => {
  const trades = getTrades();
  const trade = trades.find(t => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });

  const remaining = trades.filter(t => t.id !== req.params.id);
  if (!setTrades(remaining)) return res.status(500).json({ error: 'Failed to delete trade' });

  appendAudit({ type: 'log_deletion', actor: req.session.username,
    detail: `Deleted trade ${trade.id} (${trade.pair} ${trade.direction}, ${trade.status})` });

  res.json({ deleted: true, id: req.params.id });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Dhitta Trading Signals',
    twelveData: !!process.env.TWELVEDATA_KEY,
    gemini:     !!process.env.GEMINI_KEY,
    email:      !!(process.env.EJS_SID && process.env.EJS_PUB)
  });
});

// ── MAIN APP ──────────────────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dhitta-trading-signals.html'));
});

app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dhitta-trading-signals.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const users = getUsers();
  console.log(`\n✅ Dhitta Trading Signals running on port ${PORT}`);
  console.log(`🔐 Users: ${users.map(u => `${u.username} (${u.role})`).join(', ')}`);
  console.log(`📈 Twelve Data: ${process.env.TWELVEDATA_KEY ? '✅ Key set' : '❌ Missing — add TWELVEDATA_KEY env var'}`);
  console.log(`🤖 Gemini:      ${process.env.GEMINI_KEY    ? '✅' : '❌ Optional — add GEMINI_KEY'}`);
  console.log(`📧 Email:       ${process.env.EJS_SID        ? '✅' : '❌ Optional — add EJS_SID/TID/PUB/EMAIL_ADDR'}\n`);
});
