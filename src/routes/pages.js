const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { db, getSettings } = require('../db');
const U = require('../lib/util');
const mail = require('../lib/mailer');

const formLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => { res.flash('error', 'Too many submissions. Please try again later.'); res.redirect(req.get('referer') || '/'); } });

const simple = (path, view, title, extra = {}) => router.get(path, (req, res) => res.page(view, { title: `${title} | ${getSettings().store_name}`, ...extra }));
simple('/about', 'about', 'About us');
simple('/faq', 'faq', 'FAQs');
simple('/shipping-returns', 'shipping', 'Shipping & Returns');
simple('/privacy', 'privacy', 'Privacy Policy');
simple('/terms', 'terms', 'Terms & Conditions');
router.get('/size-guide', (req, res) => res.page('size-guide', { title: `Size Guide | ${getSettings().store_name}`, chart: U.jparse(getSettings().size_chart, []) }));

router.get('/contact', (req, res) => res.page('contact', { title: `Contact us | ${getSettings().store_name}`, form: req.session.contactForm || {} }));
router.post('/contact', formLimiter, async (req, res) => {
  if (req.body.website) return res.redirect('/contact'); // honeypot
  const m = { name: U.str(req.body.name, 80), email: U.str(req.body.email, 120), phone: U.str(req.body.phone, 20), subject: U.str(req.body.subject, 120), body: U.str(req.body.body, 3000) };
  if (m.name.length < 2 || !U.isEmail(m.email) || m.body.length < 10) {
    req.session.contactForm = m;
    res.flash('error', 'Please enter your name, a valid email and a message (at least 10 characters).');
    return res.redirect('/contact');
  }
  delete req.session.contactForm;
  await db.run('INSERT INTO messages(name,email,phone,subject,body) VALUES(?,?,?,?,?)', m.name, m.email, m.phone, m.subject, m.body);
  await mail.contactNotify(m);
  res.flash('success', 'Thank you! We have received your message and will reply soon.');
  res.redirect('/contact');
});

router.get('/feedback', async (req, res) => {
  const reviews = await db.all(`SELECT r.*, p.name pname FROM reviews r LEFT JOIN products p ON p.id = r.product_id WHERE r.status = 'approved' ORDER BY r.id DESC LIMIT 30`);
  const stats = await db.get(`SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE status = 'approved'`);
  res.page('feedback', { title: `Customer feedback | ${getSettings().store_name}`, reviews, stats });
});
router.post('/feedback', formLimiter, async (req, res) => {
  if (req.body.website) return res.redirect('/feedback');
  const rating = U.int(req.body.rating), body = U.str(req.body.body, 1200), name = U.str(req.body.name, 60) || (req.user ? req.user.name.split(' ')[0] : '');
  if (rating < 1 || rating > 5 || body.length < 5 || name.length < 2) { res.flash('error', 'Please add your name, a star rating and a few words.'); return res.redirect('/feedback'); }
  const auto = getSettings().reviews_auto_approve === '1';
  await db.run('INSERT INTO reviews(product_id,user_id,name,rating,title,body,verified,status) VALUES(NULL,?,?,?,?,?,0,?)',
    req.user ? req.user.id : null, name, rating, U.str(req.body.title, 100), body, auto ? 'approved' : 'pending');
  res.flash('success', auto ? 'Thank you for your feedback!' : 'Thank you! Your feedback will appear once approved.');
  res.redirect('/feedback');
});

router.post('/newsletter', formLimiter, async (req, res) => {
  const email = U.str(req.body.email, 120).toLowerCase();
  const wants = req.accepts(['html', 'json']) === 'json';
  if (!U.isEmail(email)) return wants ? res.status(400).json({ ok: false, error: 'Enter a valid email.' }) : (res.flash('error', 'Please enter a valid email.'), res.redirect(req.get('referer') || '/'));
  await db.run('INSERT OR IGNORE INTO subscribers(email) VALUES(?)', email);
  if (wants) return res.json({ ok: true });
  res.flash('success', 'You are subscribed. Welcome!');
  res.redirect(req.get('referer') || '/');
});

router.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`));
router.get('/sitemap.xml', async (req, res) => {
  const b = res.locals.baseUrl;
  const urls = ['/', '/shop', '/about', '/contact', '/faq', '/size-guide', '/shipping-returns', '/feedback', ...U.CATEGORIES.map((c) => '/shop/' + U.catSlug(c)),
    ...(await db.all('SELECT slug FROM products WHERE active = 1')).map((p) => '/product/' + p.slug)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${b}${u}</loc></url>`).join('')}</urlset>`);
});

module.exports = router;
