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
router.post('/login', authLimiter, async (req, res, next) => {
  const email = U.str(req.body.email, 120).toLowerCase();
  const u = await db.get('SELECT * FROM users WHERE email = ?', email);
  const nxt = U.safeNext(req.body.next);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    res.flash('error', 'Incorrect email or password.');
    return res.redirect('/login?next=' + encodeURIComponent(nxt));
  }
  startSession(req, u, (err) => (err ? next(err) : res.redirect(u.role === 'admin' && nxt === '/' ? '/admin' : nxt)));
});

router.get('/register', (req, res) => res.page('register', { title: 'Create account', next: U.safeNext(req.query.next) }));
router.post('/register', authLimiter, async (req, res, next) => {
  const name = U.str(req.body.name, 80), email = U.str(req.body.email, 120).toLowerCase(), phone = U.str(req.body.phone, 20), pw = String(req.body.password || '');
  const back = '/register?next=' + encodeURIComponent(U.safeNext(req.body.next));
  if (name.length < 2) { res.flash('error', 'Please enter your name.'); return res.redirect(back); }
  if (!U.isEmail(email)) { res.flash('error', 'Please enter a valid email address.'); return res.redirect(back); }
  if (phone && !U.isPhone(phone)) { res.flash('error', 'Please enter a valid phone number.'); return res.redirect(back); }
  if (pw.length < 8) { res.flash('error', 'Password must be at least 8 characters.'); return res.redirect(back); }
  if (await db.get('SELECT 1 x FROM users WHERE email = ?', email)) { res.flash('error', 'An account with this email already exists. Try signing in.'); return res.redirect(back); }
  const r = await db.run('INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)', name, email, phone || null, bcrypt.hashSync(pw, 10));
  // attach earlier guest orders placed with the same email
  await db.run('UPDATE orders SET user_id = ? WHERE email = ? AND user_id IS NULL', r.lastInsertRowid, email);
  startSession(req, { id: r.lastInsertRowid }, (err) => (err ? next(err) : (res.flash('success', `Welcome, ${name.split(' ')[0]}!`), res.redirect(U.safeNext(req.body.next)))));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('ojas.sid'); res.redirect('/'); });
});

/* ---------- Password reset ---------- */
router.get('/forgot', (req, res) => res.page('forgot', { title: 'Forgot password' }));
router.post('/forgot', authLimiter, async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE email = ?', U.str(req.body.email, 120).toLowerCase());
  if (u) {
    const raw = U.token(24);
    await db.run('DELETE FROM password_resets WHERE user_id = ?', u.id);
    await db.run('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)', U.sha256(raw), u.id, Date.now() + 3600e3);
    await mail.passwordReset(u, `${res.locals.baseUrl}/reset/${raw}`);
  }
  res.flash('success', 'If that email has an account, we have sent a password reset link.');
  res.redirect('/forgot');
});
router.get('/reset/:token', async (req, res) => {
  const r = await db.get('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?', U.sha256(req.params.token), Date.now());
  if (!r) { res.flash('error', 'That reset link is invalid or has expired.'); return res.redirect('/forgot'); }
  res.page('reset', { title: 'Choose a new password', tokenValue: req.params.token });
});
router.post('/reset/:token', authLimiter, async (req, res) => {
  const r = await db.get('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?', U.sha256(req.params.token), Date.now());
  if (!r) { res.flash('error', 'That reset link is invalid or has expired.'); return res.redirect('/forgot'); }
  const pw = String(req.body.password || '');
  if (pw.length < 8) { res.flash('error', 'Password must be at least 8 characters.'); return res.redirect('/reset/' + req.params.token); }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pw, 10), r.user_id);
  await db.run('DELETE FROM password_resets WHERE user_id = ?', r.user_id);
  res.flash('success', 'Password updated. Please sign in.');
  res.redirect('/login');
});

/* ---------- Account ---------- */
router.get('/account', needLogin, async (req, res) => {
  const myOrders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', req.user.id);
  for (const o of myOrders) o.items = await db.all('SELECT * FROM order_items WHERE order_id = ?', o.id);
  const address = (await db.get('SELECT * FROM addresses WHERE user_id = ? ORDER BY id DESC', req.user.id)) || {};
  res.page('account', { title: 'My account', myOrders, address });
});

router.post('/account/profile', needLogin, async (req, res) => {
  const name = U.str(req.body.name, 80), phone = U.str(req.body.phone, 20);
  if (name.length < 2) { res.flash('error', 'Please enter your name.'); return res.redirect('/account#profile'); }
  if (phone && !U.isPhone(phone)) { res.flash('error', 'Please enter a valid phone number.'); return res.redirect('/account#profile'); }
  await db.run('UPDATE users SET name = ?, phone = ? WHERE id = ?', name, phone || null, req.user.id);
  const npw = String(req.body.new_password || '');
  if (npw) {
    const u = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) { res.flash('error', 'Current password is incorrect.'); return res.redirect('/account#profile'); }
    if (npw.length < 8) { res.flash('error', 'New password must be at least 8 characters.'); return res.redirect('/account#profile'); }
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(npw, 10), req.user.id);
  }
  res.flash('success', 'Profile updated.');
  res.redirect('/account#profile');
});

router.post('/account/address', needLogin, async (req, res) => {
  const b = req.body;
  const a = { name: U.str(b.name, 80), phone: U.str(b.phone, 20), line1: U.str(b.line1, 150), line2: U.str(b.line2, 150), city: U.str(b.city, 60), state: U.str(b.state, 60), pincode: U.str(b.pincode, 10) };
  if (!a.name || !a.line1 || !a.city || !U.STATES.includes(a.state) || !U.isPin(a.pincode) || !U.isPhone(a.phone)) {
    res.flash('error', 'Please fill in the complete address (valid phone and 6-digit PIN).'); return res.redirect('/account#address');
  }
  await db.run('DELETE FROM addresses WHERE user_id = ?', req.user.id);
  await db.run('INSERT INTO addresses(user_id,name,phone,line1,line2,city,state,pincode) VALUES(?,?,?,?,?,?,?,?)', req.user.id, a.name, a.phone, a.line1, a.line2, a.city, a.state, a.pincode);
  res.flash('success', 'Address saved.');
  res.redirect('/account#address');
});

module.exports = router;
