// Server-to-server payment confirmations. These keep orders correct even if a customer closes the tab after paying.
const router = require('express').Router();
const { razorpay, stripe } = require('../lib/payments');
const orders = require('../lib/orders');

router.post('/razorpay', async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!razorpay.verifyWebhook(raw, req.get('x-razorpay-signature'))) return res.status(400).send('bad signature');
  try {
    const ev = JSON.parse(raw);
    const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if (pay && (ev.event === 'payment.captured' || ev.event === 'order.paid')) {
      const number = (pay.notes && pay.notes.order_number) || null;
      const o = number && orders.get(number);
      if (o && o.gateway_order_id === pay.order_id && pay.amount === o.total * 100) await orders.markPaid(number, { paymentId: pay.id, baseUrl: process.env.BASE_URL || '' });
    }
  } catch (e) { console.error('[razorpay webhook]', e); }
  res.json({ ok: true });
});

router.post('/stripe', async (req, res) => {
  const ev = stripe.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
  if (!ev) return res.status(400).send('bad signature');
  try {
    const s = ev.data && ev.data.object;
    if (ev.type === 'checkout.session.completed' && s && s.payment_status === 'paid') {
      const o = orders.get(s.client_reference_id);
      if (o && s.amount_total === o.total * 100) await orders.markPaid(o.number, { paymentId: s.payment_intent, baseUrl: process.env.BASE_URL || '' });
    } else if (ev.type === 'checkout.session.expired' && s) orders.markFailed(s.client_reference_id);
  } catch (e) { console.error('[stripe webhook]', e); }
  res.json({ received: true });
});

module.exports = router;
