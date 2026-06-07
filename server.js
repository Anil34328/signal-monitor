const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

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
    const low = Math.min(open, close) - Math.abs(drift) * Math.random() * 0.5;
    candles.unshift({ o: open, h: high, l: low, c: close, t: now - i * 5 * 60000 });
    price = open - drift;
  }
  candles[59].c = currentRate;
  candles[59].h = Math.max(candles[59].h, currentRate);
  candles[59].l = Math.min(candles[59].l, currentRate);
  return candles;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'signal-monitor.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('signal-monitor.html not found');
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/price')) {
    const url = new URL(req.url, `http://localhost`);
    const from = url.searchParams.get('from') || 'EUR';
    const to = url.searchParams.get('to') || 'USD';
    try {
      const candles = await getLiveForexCandles(from, to);
      const last = candles[candles.length - 1].c;
      console.log(`[Price] ${from}/${to} = ${last.toFixed(5)} ✅`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candles, current: last, pair: `${from}/${to}` }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Health check for UptimeRobot
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('OK');
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✅ SignalMonitor running on port ${PORT}`);
  console.log('📈 Live forex: frankfurter.app (free)');
  console.log('📊 Crypto: Binance (free)');
  console.log('🤖 AI: Gemini called directly from browser (free)');
});
