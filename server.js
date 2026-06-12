// ─────────────────────────────────────────────
//  Dhitta Trading Signals — server.js
//  Render start command: node server.js
// ─────────────────────────────────────────────
const express = require('express');
const session = require('express-session');
const crypto  = require('crypto'); // built-in Node — no install needed
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── USERS ────────────────────────────────────
// Passwords are read from Render Environment Variables.
// Set these in Render Dashboard → Environment tab:
//   PASS_ANIL    → anil's password
//   PASS_TRADER2 → trader2's password
//   PASS_TRADER3 → trader3's password
//
// Default fallback passwords (if env vars not set):
//   anil    → dhitta@2024
//   trader2 → signals@123
//   trader3 → dhitta@456

const USERS = [
  {
    id: 1,
    username: 'anil',
    password: process.env.PASS_ANIL || 'dhitta@2024',
    displayName: 'Anil',
    role: 'admin'
  },
  {
    id: 2,
    username: 'trader2',
    password: process.env.PASS_TRADER2 || 'signals@123',
    displayName: 'Trader 2',
    role: 'user'
  },
  {
    id: 3,
    username: 'trader3',
    password: process.env.PASS_TRADER3 || 'dhitta@456',
    displayName: 'Trader 3',
    role: 'user'
  },
  // To add more users, copy a block above and add PASS_TRADER4 etc. in Render env
];

// Safe constant-time string comparison (prevents timing attacks)
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still do the compare to avoid timing leak
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── MIDDLEWARE ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dhitta-secret-change-this-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ── AUTH MIDDLEWARE ───────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── ROUTES ────────────────────────────────────

// GET /login
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// POST /login
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.redirect('/login?error=missing');
  }

  const user = USERS.find(u =>
    u.username.toLowerCase() === username.toLowerCase().trim()
  );

  if (!user || !safeCompare(password, user.password)) {
    console.log(`[Auth] Failed login attempt: "${username}" at ${new Date().toISOString()}`);
    return res.redirect('/login?error=invalid');
  }

  // Success
  req.session.userId      = user.id;
  req.session.username    = user.username;
  req.session.displayName = user.displayName;
  req.session.role        = user.role;
  console.log(`[Auth] ✅ Login: ${user.username} (${user.role}) at ${new Date().toISOString()}`);
  res.redirect('/');
});

// POST /logout
app.post('/logout', (req, res) => {
  const name = req.session.displayName || 'User';
  req.session.destroy(() => {
    console.log(`[Auth] Logout: ${name}`);
    res.redirect('/login');
  });
});

// GET /api/me — current user info
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username:    req.session.username,
    displayName: req.session.displayName,
    role:        req.session.role
  });
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Dhitta Trading Signals', time: new Date().toISOString() });
});

// ── PROTECTED STATIC FILES ────────────────────
app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dhitta-trading-signals.html'));
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   Dhitta Trading Signals — ONLINE        ║
║   Port: ${PORT}                               ║
╚══════════════════════════════════════════╝
Users: ${USERS.map(u => u.username + ' (' + u.role + ')').join(', ')}
  `);
});
