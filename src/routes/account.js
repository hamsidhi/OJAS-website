const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const U = require('../lib/util');
const mail = require('../lib/mailer');

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => { res.flash('error', 'Too many attempts. Please wait a few minutes and try again.'); res.redirect(req.path); } });

// Keep the shopping bag when the session id is regenerated at login (prevents session fixation).
function startSession(req, user, cb) {
  const keep = { cart: req.session.cart || [], coupon: req.session.coupon, myOrders: req.session.myOrders || [] };
  req.session.regenerate((err) => {
    if (err) return cb(err);
    Object.assign(req.session, keep, { userId: user.id });
    req.session.save(cb);
  });
}
const needLogin = (req, res, next) => {
  if (req.user) return next();
  res.flash('error', 'Please sign in to continue.');
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
};

router.get('/login', (req, res) => res.page('login', { title: 'Sign in', next: U.safeNext(req.query.next) }));
router.post('/login', authLimiter, (req, res, next) => {
  const email = U.str(req.body.email, 120).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const nxt = U.safeNext(req.body.next);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    res.flash('error', 'Incorrect email or password.');
    return res.redirect('/login?next=' + encodeURIComponent(nxt));
  }
  startSession(req, u, (err) => (err ? next(err) : res.redirect(u.role === 'admin' && nxt === '/' ? '/admin' : nxt)));
});

router.get('/register', (req, res) => res.page('register', { title: 'Create account', next: U.safeNext(req.query.next) }));
router.post('/register', authLimiter, (req, res, next) => {
  const name = U.str(req.body.name, 80), email = U.str(req.body.email, 120).toLowerCase(), phone = U.str(req.body.phone, 20), pw = String(req.body.password || '');
  const back = '/register?next=' + encodeURIComponent(U.safeNext(req.body.next));
  if (name.length < 2) { res.flash('error', 'Please enter your name.'); return res.redirect(back); }
  if (!U.isEmail(email)) { res.flash('error', 'Please enter a valid email address.'); return res.redirect(back); }
  if (phone && !U.isPhone(phone)) { res.flash('error', 'Please enter a valid phone number.'); return res.redirect(back); }
  if (pw.length < 8) { res.flash('error', 'Password must be at least 8 characters.'); return res.redirect(back); }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) { res.flash('error', 'An account with this email already exists. Try signing in.'); return res.redirect(back); }
  const r = db.prepare('INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)').run(name, email, phone || null, bcrypt.hashSync(pw, 10));
  // attach earlier guest orders placed with the same email
  db.prepare('UPDATE orders SET user_id = ? WHERE email = ? AND user_id IS NULL').run(r.lastInsertRowid, email);
  startSession(req, { id: r.lastInsertRowid }, (err) => (err ? next(err) : (res.flash('success', `Welcome, ${name.split(' ')[0]}!`), res.redirect(U.safeNext(req.body.next)))));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('ojas.sid'); res.redirect('/'); });
});

/* ---------- Password reset ---------- */
router.get('/forgot', (req, res) => res.page('forgot', { title: 'Forgot password' }));
router.post('/forgot', authLimiter, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(U.str(req.body.email, 120).toLowerCase());
  if (u) {
    const raw = U.token(24);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(U.sha256(raw), u.id, Date.now() + 3600e3);
    await mail.passwordReset(u, `${res.locals.baseUrl}/reset/${raw}`);
  }
  res.flash('success', 'If that email has an account, we have sent a password reset link.');
  res.redirect('/forgot');
});
router.get('/reset/:token', (req, res) => {
  const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(U.sha256(req.params.token), Date.now());
  if (!r) { res.flash('error', 'That reset link is invalid or has expired.'); return res.redirect('/forgot'); }
  res.page('reset', { title: 'Choose a new password', tokenValue: req.params.token });
});
router.post('/reset/:token', authLimiter, (req, res) => {
  const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(U.sha256(req.params.token), Date.now());
  if (!r) { res.flash('error', 'That reset link is invalid or has expired.'); return res.redirect('/forgot'); }
  const pw = String(req.body.password || '');
  if (pw.length < 8) { res.flash('error', 'Password must be at least 8 characters.'); return res.redirect('/reset/' + req.params.token); }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), r.user_id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(r.user_id);
  res.flash('success', 'Password updated. Please sign in.');
  res.redirect('/login');
});

/* ---------- Account ---------- */
router.get('/account', needLogin, (req, res) => {
  const myOrders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  myOrders.forEach((o) => { o.items = orders_items(o.id); });
  const address = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY id DESC').get(req.user.id) || {};
  res.page('account', { title: 'My account', myOrders, address });
});
const orders_items = (id) => db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);

router.post('/account/profile', needLogin, (req, res) => {
  const name = U.str(req.body.name, 80), phone = U.str(req.body.phone, 20);
  if (name.length < 2) { res.flash('error', 'Please enter your name.'); return res.redirect('/account#profile'); }
  if (phone && !U.isPhone(phone)) { res.flash('error', 'Please enter a valid phone number.'); return res.redirect('/account#profile'); }
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone || null, req.user.id);
  const npw = String(req.body.new_password || '');
  if (npw) {
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) { res.flash('error', 'Current password is incorrect.'); return res.redirect('/account#profile'); }
    if (npw.length < 8) { res.flash('error', 'New password must be at least 8 characters.'); return res.redirect('/account#profile'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(npw, 10), req.user.id);
  }
  res.flash('success', 'Profile updated.');
  res.redirect('/account#profile');
});

router.post('/account/address', needLogin, (req, res) => {
  const b = req.body;
  const a = { name: U.str(b.name, 80), phone: U.str(b.phone, 20), line1: U.str(b.line1, 150), line2: U.str(b.line2, 150), city: U.str(b.city, 60), state: U.str(b.state, 60), pincode: U.str(b.pincode, 10) };
  if (!a.name || !a.line1 || !a.city || !U.STATES.includes(a.state) || !U.isPin(a.pincode) || !U.isPhone(a.phone)) {
    res.flash('error', 'Please fill in the complete address (valid phone and 6-digit PIN).'); return res.redirect('/account#address');
  }
  db.prepare('DELETE FROM addresses WHERE user_id = ?').run(req.user.id);
  db.prepare('INSERT INTO addresses(user_id,name,phone,line1,line2,city,state,pincode) VALUES(?,?,?,?,?,?,?,?)').run(req.user.id, a.name, a.phone, a.line1, a.line2, a.city, a.state, a.pincode);
  res.flash('success', 'Address saved.');
  res.redirect('/account#address');
});

module.exports = router;
