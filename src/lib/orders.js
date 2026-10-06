const { db, tx } = require('../db');
const { token } = require('./util');
const mail = require('./mailer');

async function newNumber() {
  const d = new Date();
  const base = `OJ${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 20; i++) {
    const n = base + String(Math.floor(1000 + Math.random() * 9000));
    if (!(await db.get('SELECT 1 x FROM orders WHERE number = ?', n))) return n;
  }
  return base + token(3).toUpperCase();
}

const get = (number) => db.get('SELECT * FROM orders WHERE number = ?', number);
const items = (orderId) => db.all('SELECT * FROM order_items WHERE order_id = ?', orderId);

// Creates the order and reserves stock atomically. `t` is the result of cart.totals().
async function create({ user, email, phone, ship, method, t, note }) {
  const number = await newNumber();
  const cod = method === 'cod';
  await tx(async (q) => {
    for (const i of t.items) {
      const r = await q.run('UPDATE variants SET stock = stock - ? WHERE product_id = ? AND color = ? AND size = ? AND stock >= ?', i.qty, i.pid, i.color, i.size, i.qty);
      if (!r.changes) throw Object.assign(new Error(`"${i.name}" (${i.color} / ${i.size}) just sold out or has fewer pieces than in your bag.`), { user: true });
    }
    const r = await q.run(`INSERT INTO orders(number,user_id,email,phone,name,ship,subtotal,discount,shipping,cod_fee,total,coupon,payment_method,payment_status,status,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, number, user ? user.id : null, email, phone, ship.name, JSON.stringify(ship), t.subtotal, t.discount,
      t.shipping, t.codFee, t.total, t.coupon ? t.coupon.code : null, method, cod ? 'cod' : 'pending', cod ? 'processing' : 'pending', note || null);
    for (const i of t.items) {
      await q.run('INSERT INTO order_items(order_id,product_id,code,name,color,size,price,qty,image) VALUES(?,?,?,?,?,?,?,?,?)',
        r.lastInsertRowid, i.pid, i.code, i.name, i.color, i.size, i.price, i.qty, i.image);
      if (cod) await q.run('UPDATE products SET sold = sold + ? WHERE id = ?', i.qty, i.pid);
    }
    if (t.coupon) await q.run('UPDATE coupons SET used = used + 1 WHERE code = ?', t.coupon.code);
  });
  return get(number);
}

async function restoreStock(q, order) {
  for (const i of await q.all('SELECT * FROM order_items WHERE order_id = ?', order.id)) {
    await q.run('UPDATE variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ?', i.qty, i.product_id, i.color, i.size);
  }
  if (order.coupon) await q.run('UPDATE coupons SET used = MAX(used - 1, 0) WHERE code = ?', order.coupon);
}

async function markPaid(number, { paymentId, baseUrl }) {
  const o = await get(number);
  if (!o || o.payment_status === 'paid') return o;
  if (o.status === 'cancelled') return o; // do not resurrect cancelled orders automatically
  // conditional update so two simultaneous confirmations (browser + webhook) only finalize once
  const r = await db.run(`UPDATE orders SET payment_status='paid', status='processing', gateway_payment_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status != 'paid'`, paymentId || null, o.id);
  const fresh = await get(number);
  if (!r.changes) return fresh;
  for (const i of await items(o.id)) await db.run('UPDATE products SET sold = sold + ? WHERE id = ?', i.qty, i.product_id);
  await finalize(fresh, baseUrl);
  return fresh;
}

// Confirmation emails (COD orders call this right after creation, online orders after payment succeeds)
async function finalize(order, baseUrl) {
  const its = await items(order.id);
  await Promise.all([mail.orderConfirmation(order, its, baseUrl), mail.adminNewOrder(order, its)]);
}

async function markFailed(number) {
  const o = await get(number);
  if (!o || o.payment_status === 'paid' || o.status === 'cancelled') return;
  await tx(async (q) => {
    await restoreStock(q, o);
    await q.run(`UPDATE orders SET payment_status='failed', status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`, o.id);
  });
}

async function cancel(number, { refunded } = {}) {
  const o = await get(number);
  if (!o || o.status === 'cancelled') return o;
  await tx(async (q) => {
    await restoreStock(q, o);
    const pay = o.payment_status === 'paid' ? (refunded ? 'refunded' : 'paid') : (o.payment_status === 'cod' ? 'cod' : 'failed');
    await q.run(`UPDATE orders SET status='cancelled', payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, pay, o.id);
  });
  return get(number);
}

// Unpaid online orders older than 45 minutes release their stock. Called from busy pages (serverless has no timers).
let lastSweep = 0;
async function expireStale() {
  if (Date.now() - lastSweep < 5 * 60 * 1000) return;
  lastSweep = Date.now();
  const rows = await db.all(`SELECT number FROM orders WHERE status='pending' AND payment_status='pending' AND payment_method != 'cod'
    AND created_at < datetime('now','-45 minutes')`);
  for (const r of rows) await markFailed(r.number);
  if (rows.length) console.log(`[orders] expired ${rows.length} unpaid order(s)`);
}

module.exports = { create, get, items, markPaid, markFailed, cancel, expireStale, finalize };
