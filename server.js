const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');
const http    = require('http');
const app     = express();
const PORT    = process.env.PORT || 3000;

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
  cookie: { maxAge: 24*60*60*1000, httpOnly: true, secure: false }
}));

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
  res.json({ username: req.session.username, displayName: req.session.displayName, role: req.session.role });
});

// ── LIVE FOREX PRICES ─────────────────────────────────────────────────────────
async function getLiveForexCandles(from, to) {
  return new Promise((resolve, reject) => {
    const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
    https.get(url, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          const rate = json.rates[to];
          if (!rate) return reject(new Error('No rate'));
          // Build synthetic candles from current rate
          const candles = [];
          let price = rate;
          const vol = rate * 0.0008;
          for (let i = 59; i >= 0; i--) {
            const drift = (Math.random() - 0.49) * vol;
            const o = price, c2 = price + drift;
            candles.unshift({ o, h: Math.max(o,c2)+Math.abs(drift)*0.5, l: Math.min(o,c2)-Math.abs(drift)*0.3, c: c2 });
            price = o - drift;
          }
          candles[59].c = rate;
          resolve(candles);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const https = require('https');

app.get('/api/price', requireAuth, async (req, res) => {
  const { from='EUR', to='USD' } = req.query;
  try {
    const candles = await getLiveForexCandles(from, to);
    res.json({ candles, current: candles[59].c });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI PROXY ──────────────────────────────────────────────────────────────────
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
      } catch(e) { res.status(500).json({ error: e.message }); }
    });
  });
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── EMAIL PROXY ───────────────────────────────────────────────────────────────
app.post('/api/send-email', requireAuth, (req, res) => {
  const { pair, signal, confidence, score, istTime, message } = req.body;
  const EJS_SID   = process.env.EJS_SID   || '';
  const EJS_TID   = process.env.EJS_TID   || '';
  const EJS_PUB   = process.env.EJS_PUB   || '';
  const EMAIL_ADDR = process.env.EMAIL_ADDR || '';

  if (!EJS_SID || !EJS_TID || !EJS_PUB || !EMAIL_ADDR) {
    return res.json({ ok: false, reason: 'Email not configured' });
  }

  const body = JSON.stringify({
    service_id: EJS_SID, template_id: EJS_TID, user_id: EJS_PUB,
    template_params: { to_email: EMAIL_ADDR, pair, signal, confidence: confidence+'%', score: score+'/100', ist_time: istTime, message }
  });

  const options = {
    hostname: 'api.emailjs.com',
    path: '/api/v1.0/email/send',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      console.log('[Email] Result:', data);
      res.json({ ok: data === 'OK' });
    });
  });
  apiReq.on('error', e => res.json({ ok: false, error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    hasGemini: !!process.env.GEMINI_KEY,
    hasEmail:  !!(process.env.EJS_SID && process.env.EJS_TID && process.env.EJS_PUB),
    emailAddr: process.env.EMAIL_ADDR || '',
    user: { name: req.session.displayName, role: req.session.role }
  });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Dhitta Trading Signals' }));

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
  console.log(`🤖 Gemini: ${process.env.GEMINI_KEY ? '✅' : '❌ Add GEMINI_KEY'}`);
  console.log(`📧 Email:  ${process.env.EJS_SID ? '✅' : '❌ Add EJS_SID/TID/PUB/EMAIL_ADDR'}\n`);
});
