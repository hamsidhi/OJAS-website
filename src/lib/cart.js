const { db, getSettings } = require('../db');
const { int } = require('./util');

const MAX_QTY = 10;
const keyOf = (pid, color, size) => `${pid}|${color}|${size}`;

const raw = (req) => (req.session.cart ||= []);

async function stockFor(pid, color, size) {
  const r = await db.get('SELECT stock FROM variants WHERE product_id = ? AND color = ? AND size = ?', pid, color, size);
  return r ? r.stock : null;
}

async function add(req, pid, color, size, qty) {
  const p = await db.get('SELECT id, active FROM products WHERE id = ?', pid);
  if (!p || !p.active) return { ok: false, error: 'This product is no longer available.' };
  const stock = await stockFor(pid, color, size);
  if (stock === null) return { ok: false, error: 'Please choose a colour and size.' };
  if (stock <= 0) return { ok: false, error: 'Sorry, that colour/size is sold out.' };
  const cart = raw(req), key = keyOf(pid, color, size);
  const line = cart.find((l) => l.key === key);
  const want = Math.min(MAX_QTY, (line ? line.qty : 0) + Math.max(1, qty));
  if (want > stock) {
    if (line) line.qty = stock; else cart.push({ key, pid, color, size, qty: stock });
    return { ok: true, message: `Only ${stock} left. We added the maximum available.` };
  }
  if (line) line.qty = want; else cart.push({ key, pid, color, size, qty: want });
  return { ok: true };
}
async function setQty(req, key, qty) {
  const cart = raw(req), i = cart.findIndex((l) => l.key === key);
  if (i < 0) return;
  if (qty <= 0) cart.splice(i, 1);
  else {
    const l = cart[i], stock = (await stockFor(l.pid, l.color, l.size)) || 0;
    l.qty = Math.max(1, Math.min(MAX_QTY, qty, stock || 1));
  }
}
function remove(req, key) { req.session.cart = raw(req).filter((l) => l.key !== key); }
function clear(req) { req.session.cart = []; delete req.session.coupon; }

// Expand the session cart into priced lines using live DB data (never trust prices from the browser).
async function lines(req) {
  const out = [], keep = [];
  for (const l of raw(req)) {
    const p = await db.get('SELECT id, code, slug, name, price, mrp, active, colors FROM products WHERE id = ?', l.pid);
    if (!p || !p.active) continue;
    const stock = await stockFor(l.pid, l.color, l.size);
    if (stock === null) continue;
    const qty = Math.min(l.qty, Math.max(stock, 0));
    const img = await db.get('SELECT url FROM product_images WHERE product_id = ? ORDER BY position LIMIT 1', p.id);
    let swatch = '#ccc';
    try { swatch = (JSON.parse(p.colors).find((c) => c.name === l.color) || {}).hex || '#ccc'; } catch {}
    keep.push({ ...l, qty: qty || l.qty });
    out.push({ key: l.key, pid: p.id, code: p.code, slug: p.slug, name: p.name, color: l.color, swatch, size: l.size, price: p.price, mrp: p.mrp,
      qty: qty || l.qty, stock, soldOut: stock <= 0, short: stock > 0 && l.qty > stock, image: img ? img.url : null, line: p.price * (qty || l.qty) });
  }
  req.session.cart = keep;
  return out;
}

async function validateCoupon(code, subtotal) {
  if (!code) return { ok: false };
  const c = await db.get('SELECT * FROM coupons WHERE code = ?', String(code).trim());
  if (!c || !c.active) return { ok: false, error: 'That coupon code is not valid.' };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { ok: false, error: 'That coupon has expired.' };
  if (c.max_uses && c.used >= c.max_uses) return { ok: false, error: 'That coupon has been fully used.' };
  if (subtotal < c.min_order) return { ok: false, error: `Add items worth ₹${c.min_order} or more to use this coupon.` };
  const amount = c.type === 'percent' ? Math.floor((subtotal * c.value) / 100) : c.value;
  return { ok: true, code: c.code, discount: Math.min(amount, subtotal), label: c.type === 'percent' ? `${c.value}% off` : `₹${c.value} off` };
}

async function totals(req, method) {
  const s = getSettings();
  const items = await lines(req);
  const subtotal = items.reduce((a, i) => a + i.line, 0);
  const count = items.reduce((a, i) => a + i.qty, 0);
  let coupon = null, discount = 0;
  if (req.session.coupon) {
    const v = await validateCoupon(req.session.coupon, subtotal);
    if (v.ok) { coupon = v; discount = v.discount; } else delete req.session.coupon;
  }
  const after = subtotal - discount;
  const freeOver = int(s.free_shipping_over);
  const shipping = !items.length ? 0 : (freeOver > 0 && after >= freeOver ? 0 : int(s.shipping_fee));
  const codFee = method === 'cod' ? int(s.cod_fee) : 0;
  return { items, count, subtotal, discount, coupon, shipping, codFee, total: after + shipping + codFee,
    freeShipLeft: freeOver > 0 && after < freeOver ? freeOver - after : 0, hasProblem: items.some((i) => i.soldOut) };
}

module.exports = { add, setQty, remove, clear, lines, totals, validateCoupon, keyOf, MAX_QTY };
