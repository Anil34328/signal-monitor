// ─────────────────────────────────────────────
//  Dhitta Trading Signals — server.js
//  Run: node server.js
//  Render start command: node server.js
// ─────────────────────────────────────────────
const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const app        = express();
const PORT       = process.env.PORT || 3000;

// ── USERS ────────────────────────────────────
// To add/remove users, edit this list.
// Passwords are hashed with bcrypt (safe).
// Generate a new hash: node -e "const b=require('bcryptjs');console.log(b.hashSync('yourpassword',10))"
//
// DEFAULT CREDENTIALS (change these before deploying!):
//   anil       / dhitta@2024
//   trader2    / signals@123
//   trader3    / dhitta@456
//
const USERS = [
  {
    id: 1,
    username: 'anil',
    // password: dhitta@2024
    passwordHash: bcrypt.hashSync(process.env.PASS_ANIL || 'dhitta@2024', 10),
    displayName: 'Anil',
    role: 'admin'
  },
  {
    id: 2,
    username: 'trader2',
    // password: signals@123
    passwordHash: bcrypt.hashSync(process.env.PASS_TRADER2 || 'signals@123', 10),
    displayName: 'Trader 2',
    role: 'user'
  },
  {
    id: 3,
    username: 'trader3',
    // password: dhitta@456
    passwordHash: bcrypt.hashSync(process.env.PASS_TRADER3 || 'dhitta@456', 10),
    displayName: 'Trader 3',
    role: 'user'
  },
  // ── Add more users below ──
  // {
  //   id: 4,
  //   username: 'trader4',
  //   passwordHash: bcrypt.hashSync(process.env.PASS_TRADER4 || 'yourpassword', 10),
  //   displayName: 'Trader 4',
  //   role: 'user'
  // },
];

// ── MIDDLEWARE ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dhitta-secret-key-change-this',
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
  if (req.session && req.session.userId) {
    return next();
  }
  // API requests get 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Page requests get login redirect
  res.redirect('/login');
}

// ── ROUTES ────────────────────────────────────

// GET /login — serve login page
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// POST /login — handle login form
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.redirect('/login?error=missing');
  }
  const user = USERS.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
  if (!user) {
    return res.redirect('/login?error=invalid');
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.redirect('/login?error=invalid');
  }
  // Success — create session
  req.session.userId      = user.id;
  req.session.username    = user.username;
  req.session.displayName = user.displayName;
  req.session.role        = user.role;
  console.log(`[Auth] Login: ${user.username} at ${new Date().toISOString()}`);
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

// GET /api/me — returns current user info (used by app)
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username:    req.session.username,
    displayName: req.session.displayName,
    role:        req.session.role
  });
});

// ── PROTECTED STATIC FILES ────────────────────
// All files in /public served only to logged-in users
app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));

// Catch-all — serve main app
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dhitta-trading-signals.html'));
});

// ── START ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Dhitta Trading Signals             ║
  ║   Server running on port ${PORT}         ║
  ║   http://localhost:${PORT}               ║
  ╚══════════════════════════════════════╝

  Users configured: ${USERS.length}
  ${USERS.map(u => `  • ${u.username} (${u.role})`).join('\n')}
  `);
});
