// End-to-end smoke test against a running server:  node tools/smoke-test.js [baseUrl]
// Covers: register, bag, coupon, COD checkout, stock reservation, tracking, admin ship/cancel + restock, CSRF protection.
const BASE = process.argv[2] || 'http://localhost:3100';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'store.db'), { readOnly: true });

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { Cookie: this.cookie };
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams({ _csrf: this.csrf, ...body }).toString(); }
    if (opts.json) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = this.csrf; headers.Accept = 'application/json'; payload = JSON.stringify(opts.json); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) {
      const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
      sc.forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
      this.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const text = await r.text();
    const m = text.match(/data-csrf="([a-f0-9]+)"/); if (m) this.csrf = m[1];
    return { status: r.status, loc: r.headers.get('location'), text };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b || {}, o); }
}
let fails = 0;
const ok = (c, msg) => { console.log((c ? ' PASS ' : ' FAIL ') + msg); if (!c) fails++; };
const stock = (pid, color, size) => db.prepare('SELECT stock FROM variants WHERE product_id=? AND color=? AND size=?').get(pid, color, size).stock;

(async () => {
  const p = db.prepare("SELECT id FROM products WHERE code='JYMN005'").get();
  const before = stock(p.id, 'Black', 'M');

  const c = new Client(); await c.get('/');
  let r = await c.post('/register', { name: 'Smoke Tester', email: `smoke${Date.now()}@example.com`, password: 'password123', next: '/' });
  ok(r.status === 302, 'register redirects');
  await c.get('/');

  r = await c.post('/cart/add', {}, { json: { pid: p.id, color: 'Black', size: 'M', qty: 2 } });
  ok(JSON.parse(r.text).ok, 'add to bag (JSON)');
  r = await c.post('/cart/add', {}, { json: { pid: p.id, color: 'Black', size: 'XXS', qty: 1 } });
  ok(r.status === 400, 'rejects unknown size');
  await c.post('/cart/coupon', { code: 'WELCOME10' });
  r = await c.get('/cart');
  ok(r.text.includes('WELCOME10'), 'coupon applied (WELCOME10)');
  ok(r.text.includes('1,998'), 'subtotal = 2 x 999');

  const bad = await new Client().post('/cart/add', { pid: p.id });
  ok(bad.status === 403, 'CSRF: POST without token is rejected');

  const form = { email: 'smoke@example.com', phone: '9876543210', name: 'Smoke Tester', line1: '1 Test Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001', method: 'cod' };
  r = await c.post('/checkout', { ...form, pincode: '12' });
  ok(r.loc === '/checkout', 'invalid PIN is rejected');
  r = await c.post('/checkout', form);
  const num = (r.loc || '').match(/\/order\/(\w+)/)?.[1];
  ok(!!num, `COD order placed (${num})`);
  ok(stock(p.id, 'Black', 'M') === before - 2, 'stock reserved (-2)');
  const o = db.prepare('SELECT * FROM orders WHERE number=?').get(num);
  ok(o.total === 1998 - 199 + 79 + 49, `total = 1998 - 10% + 79 shipping + 49 COD fee (got ${o.total})`);
  ok(o.status === 'processing' && o.payment_status === 'cod', 'COD order is processing / pay on delivery');
  r = await c.get('/order/' + num);
  ok(r.status === 200 && r.text.includes(num), 'order page visible to owner');
  const g = await new Client().get('/order/' + num);
  ok(g.status === 302 && /track/.test(g.loc), 'order page hidden from strangers');

  const t = new Client(); await t.get('/track');
  r = await t.post('/track', { number: num, email: 'wrong@example.com' }); ok(r.loc === '/track', 'track with wrong email fails');
  r = await t.post('/track', { number: num, email: 'smoke@example.com' }); ok(r.loc === '/order/' + num, 'track with right email works');

  const a = new Client(); await a.get('/login');
  r = await a.post('/login', { email: process.env.ADMIN_EMAIL || 'admin@ojas.example', password: process.env.ADMIN_PASSWORD || 'ChangeMe123!', next: '/admin' });
  ok(r.status === 302, 'admin login');
  await a.get('/admin/orders/' + num);
  await a.post('/admin/orders/' + num, { status: 'shipped', payment_status: 'cod', carrier: 'TestCourier', tracking_no: 'T1' });
  ok(db.prepare('SELECT status FROM orders WHERE number=?').get(num).status === 'shipped', 'admin marks shipped');
  r = await c.post('/admin/orders/' + num, { status: 'cancelled' });
  ok(r.status === 403 || r.status === 302, 'customer cannot use admin routes');
  ok(db.prepare('SELECT status FROM orders WHERE number=?').get(num).status === 'shipped', '...and the order was not changed');
  await a.post('/admin/orders/' + num, { status: 'cancelled' });
  ok(db.prepare('SELECT status FROM orders WHERE number=?').get(num).status === 'cancelled', 'admin cancels order');
  ok(stock(p.id, 'Black', 'M') === before, 'stock restored after cancel');

  console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
