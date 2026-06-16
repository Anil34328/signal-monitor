const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');
const https   = require('https');
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

// ── USERS ─────────────────────────────────────────────────────────────────────
const USERS = [
  { id:1, username:'anil',    password: process.env.PASS_ANIL    || 'dhitta@2024', displayName:'Anil',     role:'admin' },
  { id:2, username:'trader2', password: process.env.PASS_TRADER2 || 'signals@123', displayName:'Trader 2', role:'user'  },
  { id:3, username:'trader3', password: process.env.PASS_TRADER3 || 'dhitta@456',  displayName:'Trader 3', role:'user'  },
];

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

// ── LOGIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?error=missing');
  const user = USERS.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
  if (!user || !safeCompare(password, user.password)) {
    console.log(`[Auth] Failed: "${username}"`);
    return res.redirect('/login?error=invalid');
  }
  req.session.userId      = user.id;
  req.session.username    = user.username;
  req.session.displayName = user.displayName;
  req.session.role        = user.role;
  console.log(`[Auth] ✅ Login: ${user.username}`);
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
// Twelve Data free tier: 800 req/day, 8 req/min.
// We cache per-symbol for 5 minutes so repeated dashboard refreshes don't burn quota.
const candleCache = {};  // { [symbol]: { ts: Date.now(), candles: [...] } }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── LIVE CANDLE FETCH — TWELVE DATA ──────────────────────────────────────────
//
//  Twelve Data symbol mapping:
//    EUR/USD  → "EUR/USD"   (forex)
//    GBP/USD  → "GBP/USD"   (forex)
//    USD/JPY  → "USD/JPY"   (forex)
//    XAU/USD  → "XAU/USD"   (forex commodity)
//
//  We request 5-minute candles, 60 bars (enough for RSI-14, MACD-26, BB-20).
//
async function fetchTwelveDataCandles(symbol) {
  const key = process.env.TWELVEDATA_KEY;
  if (!key) throw new Error('TWELVEDATA_KEY environment variable not set');

  // Check cache first
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

  // Twelve Data returns newest-first — reverse to oldest-first for indicator math
  const candles = data.values
    .reverse()
    .map(v => ({
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      t: v.datetime
    }));

  // Store in cache
  candleCache[symbol] = { ts: Date.now(), candles };
  console.log(`[TwelveData] ✅ ${symbol}: ${candles.length} candles, latest close: ${candles[candles.length-1].c}`);

  return candles;
}

// ── /api/candles ENDPOINT ─────────────────────────────────────────────────────
// Frontend calls: GET /api/candles?symbol=EUR/USD
//
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

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dhitta-trading-signals.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Dhitta Trading Signals running on port ${PORT}`);
  console.log(`🔐 Users: ${USERS.map(u => u.username).join(', ')}`);
  console.log(`📈 Twelve Data: ${process.env.TWELVEDATA_KEY ? '✅ Key set' : '❌ Missing — add TWELVEDATA_KEY env var'}`);
  console.log(`🤖 Gemini:      ${process.env.GEMINI_KEY    ? '✅' : '❌ Optional — add GEMINI_KEY'}`);
  console.log(`📧 Email:       ${process.env.EJS_SID        ? '✅' : '❌ Optional — add EJS_SID/TID/PUB/EMAIL_ADDR'}\n`);
});
