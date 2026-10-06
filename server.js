require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');

const { db, getSettings, loadSettings } = require('./src/db');
const { seed } = require('./src/seed');
const SqlStore = require('./src/lib/sessionStore');
const U = require('./src/lib/util');
const orders = require('./src/lib/orders');
const payments = require('./src/lib/payments');

const prod = process.env.NODE_ENV === 'production';
const app = express();
if (prod || process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      connectSrc: ["'self'", 'https://lumberjack.razorpay.com', 'https://api.razorpay.com'],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
app.use(compression());

// Make sure the database is ready (creates tables + loads the catalogue the first time) and settings are fresh.
app.use(async (req, res, next) => {
  try { await seed(); await loadSettings(); next(); } catch (e) { next(e); }
});

// Gateway webhooks need the raw body for signature checks, so they are mounted before the body parsers.
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }), require('./src/routes/webhooks'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: prod ? '7d' : 0, index: false }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));

const sessionSecret = process.env.SESSION_SECRET || (prod ? null : 'dev-only-secret-change-me');
if (!sessionSecret) throw new Error('SESSION_SECRET must be set in production');
app.use(session({
  name: 'ojas.sid', secret: sessionSecret, resave: false, saveUninitialized: false, store: new SqlStore(),
  cookie: { httpOnly: true, sameSite: 'lax', secure: prod && process.env.INSECURE_COOKIES !== 'true', maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

// Template locals + layout helper
app.use(async (req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const s = getSettings();
  const user = req.session.userId ? await db.get('SELECT id,name,email,phone,role FROM users WHERE id = ?', req.session.userId) : null;
  if (req.session.userId && !user) delete req.session.userId;
  req.user = user || null;
  const flash = req.session.flash || null; delete req.session.flash;
  Object.assign(res.locals, {
    settings: s, user: req.user, csrf: req.session.csrf, flash, money: U.money, path: req.path, categories: U.CATEGORIES, catSlug: U.catSlug,
    STATES: U.STATES, cartCount: (req.session.cart || []).reduce((a, l) => a + l.qty, 0), ORDER_STATUS: U.ORDER_STATUS, PAY_STATUS: U.PAY_STATUS,
    PAY_METHOD: U.PAY_METHOD, title: s.store_name, metaDesc: '', ogImage: '', query: req.query, esc: U.esc,
    baseUrl: process.env.BASE_URL || `${req.protocol}://${req.get('host')}`,
    announcement: (s.announcement || '').replace('{free_shipping_over}', U.money(s.free_shipping_over)),
  });
  res.page = (view, data = {}) => {
    res.render(view, data, (err, html) => {
      if (err) return next(err);
      res.render(view.startsWith('admin/') ? 'admin/layout' : 'layout', { ...data, body: html });
    });
  };
  res.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

// CSRF protection: every state-changing request must carry the session's token.
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || (req.query && req.query._csrf);
    if (!sent || sent.length !== req.session.csrf.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf))) {
      if (req.accepts(['html', 'json']) === 'json' || req.is('json')) return res.status(403).json({ ok: false, error: 'Session expired. Please refresh the page.' });
      return res.status(403).page('error', { title: 'Session expired', code: 403, message: 'Your session expired. Please go back, refresh the page and try again.' });
    }
  }
  next();
});

app.use(require('./src/routes/shop'));
app.use(require('./src/routes/cart'));
app.use(require('./src/routes/account'));
app.use(require('./src/routes/pages'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).page('error', { title: 'Page not found', code: 404, message: "We couldn't find that page." }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return;
  if (!res.page) return res.status(500).type('text/plain').send('The store is starting up or its database is unreachable. Please try again in a moment.');
  if (req.accepts(['html', 'json']) === 'json') return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  res.status(500).page('error', { title: 'Something went wrong', code: 500, message: 'Something went wrong on our side. Please try again in a moment.' });
});

module.exports = app;

// Local / traditional hosting: start a server. (On Vercel the app is imported by api/index.js instead.)
if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  seed().then(() => {
    setInterval(() => orders.expireStale().catch((e) => console.error(e)), 10 * 60 * 1000).unref();
    app.listen(port, () => {
      const s = getSettings();
      console.log(`\n  ${s.store_name} store running at http://localhost:${port}`);
      console.log(`  Admin panel:  http://localhost:${port}/admin`);
      console.log(`  Payments:     razorpay=${payments.razorpay.enabled()} stripe=${payments.stripe.enabled()} cod=${s.cod_enabled === '1'} demo=${payments.demo.enabled()}\n`);
    });
  }).catch((e) => { console.error('Could not start:', e); process.exit(1); });
}
