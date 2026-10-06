// Payment gateway helpers. Talks to Razorpay / Stripe over their REST APIs (no SDKs needed).
const crypto = require('crypto');

const razorpay = {
  enabled: () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  keyId: () => process.env.RAZORPAY_KEY_ID,
  async createOrder(order) {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64'),
      },
      body: JSON.stringify({ amount: order.total * 100, currency: 'INR', receipt: order.number, notes: { order_number: order.number } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error && data.error.description ? data.error.description : 'Razorpay order creation failed');
    return data; // { id, amount, currency, ... }
  },
  verify(orderId, paymentId, signature) {
    if (!orderId || !paymentId || !signature) return false;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    return safeEq(expected, String(signature));
  },
  verifyWebhook(rawBody, signature) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    return safeEq(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), String(signature));
  },
};

const stripe = {
  enabled: () => !!process.env.STRIPE_SECRET_KEY,
  async createSession(order, { successUrl, cancelUrl }) {
    const p = new URLSearchParams();
    p.set('mode', 'payment');
    p.set('success_url', successUrl);
    p.set('cancel_url', cancelUrl);
    p.set('client_reference_id', order.number);
    p.set('customer_email', order.email);
    p.set('metadata[order_number]', order.number);
    p.set('line_items[0][quantity]', '1');
    p.set('line_items[0][price_data][currency]', (process.env.STRIPE_CURRENCY || 'inr').toLowerCase());
    p.set('line_items[0][price_data][unit_amount]', String(order.total * 100));
    p.set('line_items[0][price_data][product_data][name]', `Order ${order.number}`);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ? data.error.message : 'Stripe session creation failed');
    return data;
  },
  async retrieveSession(id) {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ? data.error.message : 'Stripe lookup failed');
    return data;
  },
  verifyWebhook(rawBody, header) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !header) return null;
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')));
    if (!parts.t || !parts.v1) return null;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    return safeEq(expected, parts.v1) ? JSON.parse(rawBody) : null;
  },
};

// Demo gateway: lets you click through the whole payment flow with no keys. Never enabled in production unless forced.
const demo = { enabled: () => String(process.env.DEMO_PAYMENTS || (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' };

function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function available(settings, total) {
  const m = [];
  if (razorpay.enabled()) m.push({ id: 'razorpay', label: 'UPI, Cards, Netbanking, Wallets', sub: 'Pay securely with Razorpay' });
  if (stripe.enabled()) m.push({ id: 'stripe', label: 'International / Credit & Debit Card', sub: 'Pay securely with Stripe' });
  if (demo.enabled()) m.push({ id: 'demo', label: 'Demo online payment (testing only)', sub: 'No money is charged. Disable by setting DEMO_PAYMENTS=false' });
  if (settings.cod_enabled === '1' && (!Number(settings.cod_max) || total <= Number(settings.cod_max))) {
    m.push({ id: 'cod', label: 'Cash on Delivery', sub: Number(settings.cod_fee) ? `Extra ₹${settings.cod_fee} COD fee` : 'Pay when your order arrives' });
  }
  return m;
}

module.exports = { razorpay, stripe, demo, available };
