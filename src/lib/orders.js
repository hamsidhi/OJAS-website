const { db, tx } = require('../db');
const { token } = require('./util');
const mail = require('./mailer');

function newNumber() {
  const d = new Date();
  const base = `OJ${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 20; i++) {
    const n = base + String(Math.floor(1000 + Math.random() * 9000));
    if (!db.prepare('SELECT 1 FROM orders WHERE number = ?').get(n)) return n;
  }
  return base + token(3).toUpperCase();
}

// Creates the order and reserves stock atomically. `t` is the result of cart.totals().
function create({ user, email, phone, ship, method, t, note }) {
  return tx(() => {
    for (const i of t.items) {
      const r = db.prepare('UPDATE variants SET stock = stock - ? WHERE product_id = ? AND color = ? AND size = ? AND stock >= ?')
        .run(i.qty, i.pid, i.color, i.size, i.qty);
      if (!r.changes) throw Object.assign(new Error(`"${i.name}" (${i.color} / ${i.size}) just sold out or has fewer pieces than in your bag.`), { user: true });
    }
    const number = newNumber();
    const cod = method === 'cod';
    const r = db.prepare(`INSERT INTO orders(number,user_id,email,phone,name,ship,subtotal,discount,shipping,cod_fee,total,coupon,payment_method,payment_status,status,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, user ? user.id : null, email, phone, ship.name, JSON.stringify(ship), t.subtotal, t.discount,
      t.shipping, t.codFee, t.total, t.coupon ? t.coupon.code : null, method, cod ? 'cod' : 'pending', cod ? 'processing' : 'pending', note || null);
    const ins = db.prepare('INSERT INTO order_items(order_id,product_id,code,name,color,size,price,qty,image) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const i of t.items) ins.run(r.lastInsertRowid, i.pid, i.code, i.name, i.color, i.size, i.price, i.qty, i.image);
    if (t.coupon) db.prepare('UPDATE coupons SET used = used + 1 WHERE code = ?').run(t.coupon.code);
    const created = get(number);
    if (cod) bumpSold(created);
    return created;
  });
}

const get = (number) => db.prepare('SELECT * FROM orders WHERE number = ?').get(number);
const items = (orderId) => db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

function restoreStock(order) {
  for (const i of items(order.id)) {
    db.prepare('UPDATE variants SET stock = stock + ? WHERE product_id = ? AND color = ? AND size = ?').run(i.qty, i.product_id, i.color, i.size);
  }
  if (order.coupon) db.prepare('UPDATE coupons SET used = MAX(used - 1, 0) WHERE code = ?').run(order.coupon);
}

async function markPaid(number, { paymentId, baseUrl }) {
  const o = get(number);
  if (!o || o.payment_status === 'paid') return o;
  if (o.status === 'cancelled') return o; // do not resurrect cancelled orders automatically
  db.prepare(`UPDATE orders SET payment_status='paid', status='processing', gateway_payment_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(paymentId || null, o.id);
  const fresh = get(number);
  bumpSold(o);
  finalize(fresh, baseUrl);
  return fresh;
}

function bumpSold(order) {
  for (const i of items(order.id)) db.prepare('UPDATE products SET sold = sold + ? WHERE id = ?').run(i.qty, i.product_id);
}

// Confirmation emails (COD orders call this right after creation, online orders after payment succeeds)
function finalize(order, baseUrl) {
  const its = items(order.id);
  mail.orderConfirmation(order, its, baseUrl);
  mail.adminNewOrder(order, its);
}

function markFailed(number) {
  const o = get(number);
  if (!o || o.payment_status === 'paid' || o.status === 'cancelled') return;
  tx(() => {
    restoreStock(o);
    db.prepare(`UPDATE orders SET payment_status='failed', status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(o.id);
  });
}

function cancel(number, { refunded } = {}) {
  const o = get(number);
  if (!o || o.status === 'cancelled') return o;
  tx(() => {
    restoreStock(o);
    const pay = o.payment_status === 'paid' ? (refunded ? 'refunded' : 'paid') : (o.payment_status === 'cod' ? 'cod' : 'failed');
    db.prepare(`UPDATE orders SET status='cancelled', payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(pay, o.id);
  });
  return get(number);
}

// Unpaid online orders older than 45 minutes release their stock.
function expireStale() {
  const rows = db.prepare(`SELECT number FROM orders WHERE status='pending' AND payment_status='pending' AND payment_method != 'cod'
    AND created_at < datetime('now','-45 minutes')`).all();
  rows.forEach((r) => markFailed(r.number));
  if (rows.length) console.log(`[orders] expired ${rows.length} unpaid order(s)`);
}

module.exports = { create, get, items, markPaid, markFailed, cancel, expireStale, finalize, restoreStock };
