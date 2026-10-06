const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { db, getSettings } = require('../db');
const cart = require('../lib/cart');
const orders = require('../lib/orders');
const P = require('../lib/payments');
const U = require('../lib/util');

const wantsJson = (req) => req.is('json') || req.accepts(['html', 'json']) === 'json';
const base = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

function canView(req, o) {
  return !!o && ((req.user && (req.user.role === 'admin' || o.user_id === req.user.id)) || (req.session.myOrders || []).includes(o.number));
}
function remember(req, number) { (req.session.myOrders ||= []).push(number); req.session.myOrders = req.session.myOrders.slice(-20); }

/* ---------- Cart ---------- */
router.get('/cart', (req, res) => {
  const t = cart.totals(req);
  res.page('cart', { title: 'Your Bag', t });
});

router.post('/cart/add', (req, res) => {
  const r = cart.add(req, U.int(req.body.pid), U.str(req.body.color, 60), U.str(req.body.size, 10), Math.min(10, U.int(req.body.qty, 1)));
  const count = (req.session.cart || []).reduce((a, l) => a + l.qty, 0);
  if (wantsJson(req)) return res.status(r.ok ? 200 : 400).json({ ...r, count });
  if (!r.ok) { res.flash('error', r.error); return res.redirect(req.get('referer') || '/shop'); }
  res.redirect(req.body.buy === '1' ? '/checkout' : '/cart');
});
router.post('/cart/update', (req, res) => { cart.setQty(req, String(req.body.key), U.int(req.body.qty)); res.redirect('/cart'); });
router.post('/cart/remove', (req, res) => { cart.remove(req, String(req.body.key)); res.redirect('/cart'); });
router.post('/cart/coupon', (req, res) => {
  const t = cart.totals(req);
  const v = cart.validateCoupon(req.body.code, t.subtotal);
  if (v.ok) { req.session.coupon = v.code; res.flash('success', `Coupon ${v.code} applied (${v.label}).`); }
  else res.flash('error', v.error || 'Enter a coupon code.');
  res.redirect(req.body.from === 'checkout' ? '/checkout' : '/cart');
});
router.post('/cart/coupon/remove', (req, res) => { delete req.session.coupon; res.redirect(req.body.from === 'checkout' ? '/checkout' : '/cart'); });

/* ---------- Checkout ---------- */
router.get('/checkout', (req, res) => {
  const t = cart.totals(req);
  if (!t.items.length) { res.flash('error', 'Your bag is empty.'); return res.redirect('/cart'); }
  const method = P.available(getSettings(), t.total)[0];
  const saved = req.user ? db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY id DESC').get(req.user.id) : null;
  const form = req.session.checkoutForm || {};
  res.page('checkout', { title: 'Checkout', t, methods: P.available(getSettings(), t.total), selected: form.method || (method && method.id),
    form: { name: req.user ? req.user.name : '', email: req.user ? req.user.email : '', phone: req.user ? req.user.phone : '', ...(saved || {}), ...form } });
});

const checkoutLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.post('/checkout', checkoutLimiter, async (req, res) => {
  const b = req.body;
  const form = { name: U.str(b.name, 80), email: U.str(b.email, 120).toLowerCase(), phone: U.str(b.phone, 20), line1: U.str(b.line1, 150), line2: U.str(b.line2, 150),
    city: U.str(b.city, 60), state: U.str(b.state, 60), pincode: U.str(b.pincode, 10), method: U.str(b.method, 20), note: U.str(b.note, 300) };
  req.session.checkoutForm = form;
  const fail = (msg) => { res.flash('error', msg); return res.redirect('/checkout'); };

  const t = cart.totals(req, form.method);
  if (!t.items.length) return res.redirect('/cart');
  if (t.hasProblem) return fail('Some items in your bag are sold out. Please remove them to continue.');
  if (form.name.length < 2) return fail('Please enter your full name.');
  if (!U.isEmail(form.email)) return fail('Please enter a valid email address.');
  if (!U.isPhone(form.phone)) return fail('Please enter a valid phone number.');
  if (form.line1.length < 5 || !form.city || !U.STATES.includes(form.state)) return fail('Please complete your delivery address.');
  if (!U.isPin(form.pincode)) return fail('Please enter a valid 6-digit PIN code.');
  const method = P.available(getSettings(), t.total).find((m) => m.id === form.method);
  if (!method) return fail('Please choose a payment method.');

  let order;
  try {
    order = orders.create({ user: req.user, email: form.email, phone: form.phone, method: method.id, t, note: form.note,
      ship: { name: form.name, phone: form.phone, line1: form.line1, line2: form.line2, city: form.city, state: form.state, pincode: form.pincode } });
  } catch (e) {
    if (e.user) return fail(e.message);
    throw e;
  }
  if (req.user && b.save_address) {
    db.prepare('DELETE FROM addresses WHERE user_id = ?').run(req.user.id);
    db.prepare('INSERT INTO addresses(user_id,name,phone,line1,line2,city,state,pincode) VALUES(?,?,?,?,?,?,?,?)')
      .run(req.user.id, form.name, form.phone, form.line1, form.line2, form.city, form.state, form.pincode);
    if (!req.user.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(form.phone, req.user.id);
  }
  remember(req, order.number);
  cart.clear(req);
  delete req.session.checkoutForm;
  if (method.id === 'cod') { orders.finalize(order, base(req)); return res.redirect(`/order/${order.number}?placed=1`); }
  res.redirect(`/pay/${order.number}`);
});

/* ---------- Pay ---------- */
router.get('/pay/:number', async (req, res) => {
  const o = orders.get(req.params.number);
  if (!canView(req, o)) return res.status(404).page('error', { title: 'Not found', code: 404, message: 'Order not found.' });
  if (o.payment_status === 'paid' || o.payment_method === 'cod') return res.redirect(`/order/${o.number}`);
  if (o.status === 'cancelled') return res.page('error', { title: 'Order cancelled', code: '', message: 'This order was cancelled because payment was not completed. Your items were released, so please place the order again.' });

  if (o.payment_method === 'razorpay' && P.razorpay.enabled()) {
    try {
      if (!o.gateway_order_id) {
        const g = await P.razorpay.createOrder(o);
        db.prepare('UPDATE orders SET gateway_order_id = ? WHERE id = ?').run(g.id, o.id);
        o.gateway_order_id = g.id;
      }
    } catch (e) { console.error('[razorpay]', e.message); return res.page('error', { title: 'Payment unavailable', code: '', message: 'We could not start the payment. Please try again in a moment or choose Cash on Delivery.' }); }
    return res.page('pay-razorpay', { title: 'Complete payment', o, key: P.razorpay.keyId() });
  }
  if (o.payment_method === 'stripe' && P.stripe.enabled()) {
    try {
      const s = await P.stripe.createSession(o, { successUrl: `${base(req)}/pay/stripe/return?order=${o.number}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${base(req)}/pay/stripe/cancel?order=${o.number}` });
      db.prepare('UPDATE orders SET gateway_order_id = ? WHERE id = ?').run(s.id, o.id);
      return res.redirect(303, s.url);
    } catch (e) { console.error('[stripe]', e.message); return res.page('error', { title: 'Payment unavailable', code: '', message: 'We could not start the card payment. Please try again in a moment.' }); }
  }
  if (o.payment_method === 'demo' && P.demo.enabled()) return res.page('pay-demo', { title: 'Demo payment', o });
  res.page('error', { title: 'Payment unavailable', code: '', message: 'This payment method is not available right now. Please contact us.' });
});

router.post('/pay/razorpay/verify', async (req, res) => {
  const o = orders.get(U.str(req.body.number, 30));
  if (!canView(req, o) || !o.gateway_order_id || o.gateway_order_id !== req.body.razorpay_order_id) return res.status(400).json({ ok: false, error: 'Invalid order.' });
  if (!P.razorpay.verify(req.body.razorpay_order_id, req.body.razorpay_payment_id, req.body.razorpay_signature)) return res.status(400).json({ ok: false, error: 'Payment verification failed.' });
  await orders.markPaid(o.number, { paymentId: req.body.razorpay_payment_id, baseUrl: base(req) });
  res.json({ ok: true, redirect: `/order/${o.number}?placed=1` });
});

router.get('/pay/stripe/return', async (req, res) => {
  const o = orders.get(U.str(req.query.order, 30));
  if (!canView(req, o)) return res.redirect('/');
  try {
    const s = await P.stripe.retrieveSession(String(req.query.session_id));
    if (s.client_reference_id === o.number && s.payment_status === 'paid' && s.amount_total === o.total * 100) {
      await orders.markPaid(o.number, { paymentId: s.payment_intent, baseUrl: base(req) });
      return res.redirect(`/order/${o.number}?placed=1`);
    }
  } catch (e) { console.error('[stripe return]', e.message); }
  res.redirect(`/order/${o.number}`);
});
router.get('/pay/stripe/cancel', (req, res) => {
  const o = orders.get(U.str(req.query.order, 30));
  res.redirect(o && canView(req, o) ? `/order/${o.number}` : '/');
});

router.post('/pay/demo/:number', async (req, res) => {
  if (!P.demo.enabled()) return res.status(404).end();
  const o = orders.get(req.params.number);
  if (!canView(req, o) || o.payment_method !== 'demo') return res.status(404).end();
  if (req.body.result === 'success') { await orders.markPaid(o.number, { paymentId: 'demo_' + Date.now(), baseUrl: base(req) }); return res.redirect(`/order/${o.number}?placed=1`); }
  res.redirect(`/order/${o.number}`);
});

/* ---------- Order view / tracking ---------- */
router.get('/order/:number', (req, res) => {
  const o = orders.get(req.params.number);
  if (!canView(req, o)) { res.flash('error', 'Please sign in or use "Track order" with your email to view that order.'); return res.redirect('/track?order=' + encodeURIComponent(req.params.number)); }
  res.page('order', { title: `Order ${o.number}`, o, items: orders.items(o.id), ship: U.jparse(o.ship, {}), placed: req.query.placed === '1', print: req.query.print === '1' });
});

router.post('/order/:number/cancel', (req, res) => {
  const o = orders.get(req.params.number);
  if (!canView(req, o)) return res.status(404).end();
  if (o.payment_status === 'pending' && o.status === 'pending') { orders.markFailed(o.number); res.flash('success', 'Order cancelled.'); }
  res.redirect(`/order/${o.number}`);
});

const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
router.get('/track', (req, res) => res.page('track', { title: 'Track your order', number: U.str(req.query.order, 30) }));
router.post('/track', trackLimiter, (req, res) => {
  const o = orders.get(U.str(req.body.number, 30).toUpperCase());
  if (!o || o.email.toLowerCase() !== U.str(req.body.email, 120).toLowerCase()) {
    res.flash('error', 'We could not find an order with those details.');
    return res.redirect('/track');
  }
  remember(req, o.number);
  res.redirect(`/order/${o.number}`);
});

module.exports = router;
