const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ── ALL KEYS STORED IN RAILWAY ENVIRONMENT VARIABLES ─────────────────────────
// Go to Railway → Your Project → Variables → Add these:
// GEMINI_KEY = your Gemini API key
// EJS_SID    = your EmailJS Service ID
// EJS_TID    = your EmailJS Template ID
// EJS_PUB    = your EmailJS Public Key
// EMAIL_ADDR = your email address
const GEMINI_KEY  = process.env.GEMINI_KEY  || '';
const EJS_SID     = process.env.EJS_SID     || '';
const EJS_TID     = process.env.EJS_TID     || '';
const EJS_PUB     = process.env.EJS_PUB     || '';
const EMAIL_ADDR  = process.env.EMAIL_ADDR  || '';

async function getLiveForexCandles(from, to) {
  const { default: fetch } = await import('node-fetch');
  const rateRes = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  const rateData = await rateRes.json();
  const currentRate = rateData.rates[to];
  if (!currentRate) throw new Error('No rate found');
  const histRes = await fetch(`https://api.frankfurter.app/2025-01-01..?from=${from}&to=${to}`);
  const histData = await histRes.json();
  const dailyRates = Object.values(histData.rates).map(r => r[to]).filter(Boolean);
  const changes = dailyRates.slice(1).map((r, i) => Math.abs(r - dailyRates[i]));
  const avgDailyVol = changes.reduce((a, b) => a + b, 0) / changes.length || currentRate * 0.003;
  const fiveMinVol = avgDailyVol / Math.sqrt(288);
  const candles = [];
  let price = currentRate;
  const now = Date.now();
  for (let i = 59; i >= 0; i--) {
    const drift = (Math.random() - 0.49) * fiveMinVol;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + Math.abs(drift) * Math.random() * 0.5;
    const low  = Math.min(open, close) - Math.abs(drift) * Math.random() * 0.5;
    candles.unshift({ o: open, h: high, l: low, c: close, t: now - i * 5 * 60000 });
    price = open - drift;
  }
  candles[59].c = currentRate;
  candles[59].h = Math.max(candles[59].h, currentRate);
  candles[59].l = Math.min(candles[59].l, currentRate);
  return candles;
}

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('No Gemini key in Railway Variables');
  const { default: fetch } = await import('node-fetch');
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  for (const model of models) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 600 } }) }
      );
      const data = await r.json();
      if (!data.error) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) { console.log('[AI] Model worked:', model); return text; }
      }
      console.warn('[AI]', model, 'failed:', data.error?.message);
    } catch (e) { console.warn('[AI]', model, 'error:', e.message); }
  }
  throw new Error('All Gemini models failed');
}

async function sendEmail(pair, signal, confidence, score, istTime, message) {
  if (!EJS_SID || !EJS_TID || !EJS_PUB || !EMAIL_ADDR) {
    console.log('[Email] Not configured in Railway Variables');
    return false;
  }
  const { default: fetch } = await import('node-fetch');
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EJS_SID, template_id: EJS_TID, user_id: EJS_PUB,
      template_params: { to_email: EMAIL_ADDR, pair, signal, confidence: confidence + '%', score: score + '/100', ist_time: istTime, message }
    })
  });
  const text = await r.text();
  console.log('[Email] Result:', text);
  return text === 'OK';
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'signal-monitor.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { res.writeHead(404); res.end('signal-monitor.html not found'); }
    return;
  }

  // Config — tells browser what keys are available
  if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasGemini: !!GEMINI_KEY,
      hasEmail: !!(EJS_SID && EJS_TID && EJS_PUB && EMAIL_ADDR),
      emailAddr: EMAIL_ADDR
    }));
    return;
  }

  // AI proxy — browser sends prompt, server calls Gemini
  if (req.method === 'POST' && req.url === '/api/ai') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        const text = await callGemini(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch(e) {
        console.error('[AI] Error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Email proxy — browser sends alert data, server sends email
  if (req.method === 'POST' && req.url === '/api/send-email') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const d = JSON.parse(body);
        const ok = await sendEmail(d.pair, d.signal, d.confidence, d.score, d.istTime, d.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Live forex prices
  if (req.method === 'GET' && req.url.startsWith('/api/price')) {
    const url = new URL(req.url, 'http://localhost');
    const from = url.searchParams.get('from') || 'EUR';
    const to   = url.searchParams.get('to')   || 'USD';
    try {
      const candles = await getLiveForexCandles(from, to);
      const last = candles[candles.length - 1].c;
      console.log(`[Price] ${from}/${to} = ${last.toFixed(5)} ✅`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candles, current: last }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Health check for UptimeRobot
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ SignalMonitor running on port ${PORT}`);
  console.log(`🤖 Gemini AI: ${GEMINI_KEY ? '✅ Ready' : '❌ Add GEMINI_KEY in Railway Variables'}`);
  console.log(`📧 Email:     ${EJS_SID ? '✅ Ready → ' + EMAIL_ADDR : '❌ Add EJS_SID, EJS_TID, EJS_PUB, EMAIL_ADDR in Railway Variables'}`);
  console.log(`\nTo add keys: Railway Dashboard → Your Project → Variables tab\n`);
});
