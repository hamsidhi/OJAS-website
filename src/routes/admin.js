const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, tx, getSettings, setSettings, DEFAULT_SETTINGS } = require('../db');
const U = require('../lib/util');
const C = require('../lib/catalog');
const orders = require('../lib/orders');
const mail = require('../lib/mailer');
const P = require('../lib/payments');
const storage = require('../lib/storage');

router.use((req, res, next) => {
  if (!req.user) { res.flash('error', 'Please sign in with your admin account.'); return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); }
  if (req.user.role !== 'admin') return res.status(403).page('error', { title: 'Not allowed', code: 403, message: 'This area is for store admins only.' });
  res.locals.adminPath = req.path;
  next();
});

// Photos are kept in memory, then saved by lib/storage (Vercel Blob in production, local folder in development).
// Vercel limits a request body to ~4.5MB in total, so keep photos small.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});
const base = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const back = (req, res, fallback) => res.redirect(req.get('referer') || fallback);
const one = async (sql, ...a) => (await db.get(sql, ...a));

/* ---------- Dashboard ---------- */
router.get('/', async (req, res) => {
  orders.expireStale().catch(() => {});
  const live = "status != 'cancelled'";
  const v = async (sql, ...a) => (await db.get(sql, ...a)).v;
  const [revenue, revenue30, ordersN, today, toShip, customers, pendingReviews, newMessages, lowStock, products, recent, top, reviewed] = await Promise.all([
    v(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${live}`),
    v(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${live} AND created_at > datetime('now','-30 days')`),
    v(`SELECT COUNT(*) v FROM orders WHERE ${live}`),
    v(`SELECT COUNT(*) v FROM orders WHERE ${live} AND date(created_at) = date('now')`),
    v(`SELECT COUNT(*) v FROM orders WHERE status = 'processing'`),
    v(`SELECT COUNT(*) v FROM users WHERE role = 'customer'`),
    v(`SELECT COUNT(*) v FROM reviews WHERE status = 'pending'`),
    v(`SELECT COUNT(*) v FROM messages WHERE status = 'new'`),
    v('SELECT COUNT(*) v FROM variants v JOIN products p ON p.id = v.product_id WHERE p.active = 1 AND v.stock <= ?', U.int(getSettings().low_stock, 5)),
    v('SELECT COUNT(*) v FROM products WHERE active = 1'),
    db.all('SELECT * FROM orders ORDER BY id DESC LIMIT 8'),
    db.all('SELECT id, name, code, sold FROM products WHERE sold > 0 ORDER BY sold DESC LIMIT 5'),
    one("SELECT 1 x FROM settings WHERE key = 'pricing_reviewed'"),
  ]);
  const stats = { revenue, revenue30, orders: ordersN, today, toShip, customers, pendingReviews, newMessages, lowStock, products };
  const s = getSettings();
  const checklist = [
    { done: s.email !== DEFAULT_SETTINGS.email && s.phone !== DEFAULT_SETTINGS.phone, text: 'Add your real email, phone, WhatsApp and address', link: '/admin/settings' },
    { done: P.razorpay.enabled() || P.stripe.enabled(), text: 'Connect a payment gateway (Razorpay or Stripe keys in the environment settings)', link: '/admin/settings#payments' },
    { done: mail.emailEnabled(), text: 'Set up SMTP so order emails are sent (environment settings)' },
    { done: !P.demo.enabled(), text: 'Turn off demo payments before going live (DEMO_PAYMENTS=false)' },
    { done: !!process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'ChangeMe123!', text: 'Change the default admin password (Account > Profile)', link: '/account#profile' },
    { done: !!reviewed, text: 'Review prices and stock for all products (starting prices are placeholders)', link: '/admin/products?reviewed=1' },
    { done: storage.enabled() || !process.env.VERCEL, text: 'Connect photo storage (Vercel Blob) so uploaded product photos are kept' },
  ];
  res.page('admin/dashboard', { title: 'Dashboard', stats, recent, top, checklist });
});

/* ---------- Products ---------- */
router.get('/products', async (req, res) => {
  if (req.query.reviewed === '1') await db.run("INSERT OR REPLACE INTO settings(key,value) VALUES('pricing_reviewed','1')");
  const q = U.str(req.query.q, 60), cat = U.CATEGORIES.includes(req.query.cat) ? req.query.cat : '';
  const where = ['1=1'], a = [];
  if (q) { where.push('(name LIKE ? OR code LIKE ?)'); a.push(`%${q}%`, `%${q}%`); }
  if (cat) { where.push('category = ?'); a.push(cat); }
  if (req.query.low === '1') where.push('id IN (SELECT product_id FROM variants GROUP BY product_id HAVING MIN(stock) <= ' + U.int(getSettings().low_stock, 5) + ')');
  const rows = await C.attach((await db.all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id DESC`, ...a)).map(C.hydrate));
  res.page('admin/products', { title: 'Products', rows, q, cat });
});

async function productForm(req, res, p) {
  const variants = p ? await C.variantsFor(p.id) : [];
  const stock = {}; variants.forEach((v) => (stock[v.color + '|' + v.size] = v.stock));
  res.page('admin/product-form', { title: p ? 'Edit product' : 'New product', p, stock, allSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] });
}
router.get('/products/new', (req, res) => productForm(req, res, null));
router.get('/products/:id', async (req, res) => {
  const p = await C.getById(U.int(req.params.id));
  if (!p) return res.redirect('/admin/products');
  p.imageRows = await db.all('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id', p.id);
  productForm(req, res, p);
});

function parseColors(text) {
  const out = [], seen = new Set();
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^(.*?)[\s,:|]*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})?$/);
    const name = (m && m[1] || '').trim().slice(0, 40);
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({ name, hex: (m[2] || '#cccccc').toLowerCase() });
  });
  return out.slice(0, 40);
}

router.post('/products/save', upload.array('images', 8), async (req, res) => {
  const b = req.body, id = U.int(b.id);
  const colors = parseColors(b.colors);
  const sizes = [...new Set(String(b.sizes || '').split(/[\s,\/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  const name = U.str(b.name, 120), code = U.str(b.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const price = U.int(b.price), mrp = U.int(b.mrp);
  const err = !name ? 'Name is required.' : !code ? 'Style code is required.' : !U.CATEGORIES.includes(b.category) ? 'Choose a category.' : price <= 0 ? 'Enter a valid price.'
    : !colors.length ? 'Add at least one colour.' : !sizes.length ? 'Add at least one size.' : null;
  const fail = (m) => { res.flash('error', m); return res.redirect(id ? `/admin/products/${id}` : '/admin/products/new'); };
  if (err) return fail(err);
  const extras = String(b.extras || '').split(/\r?\n/).map((l) => l.split(':')).filter((x) => x.length >= 2 && x[0].trim()).map((x) => [x[0].trim().slice(0, 30), x.slice(1).join(':').trim().slice(0, 120)]);
  const slug = U.slugify(code);
  if (await db.get('SELECT id FROM products WHERE (code = ? OR slug = ?) AND id != ?', code, slug, id)) return fail('Another product already uses that style code.');
  const defStock = Math.max(0, U.int(b.default_stock, 0));

  let uploaded = [];
  try { uploaded = await Promise.all((req.files || []).map((f) => storage.save(f))); }
  catch (e) { console.error('[upload]', e.message); return fail('Photo upload failed: ' + e.message); }

  let pid = id;
  const toDelete = [];
  await tx(async (q) => {
    const vals = [code, slug, name, b.category, U.str(b.description, 2000), U.str(b.composition, 200), JSON.stringify(extras), JSON.stringify(colors), JSON.stringify(sizes), price, mrp || null, b.active ? 1 : 0, b.featured ? 1 : 0, b.is_new ? 1 : 0];
    if (id) {
      await q.run('UPDATE products SET code=?,slug=?,name=?,category=?,description=?,composition=?,extras=?,colors=?,sizes=?,price=?,mrp=?,active=?,featured=?,is_new=? WHERE id=?', ...vals, id);
    } else {
      pid = (await q.run('INSERT INTO products(code,slug,name,category,description,composition,extras,colors,sizes,price,mrp,active,featured,is_new) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...vals)).lastInsertRowid;
    }
    // sync variants (keep existing stock, apply grid inputs, default for new combos)
    const existing = {}; (await q.all('SELECT color,size,stock FROM variants WHERE product_id = ?', pid)).forEach((v) => (existing[v.color + '|' + v.size] = v.stock));
    await q.run('DELETE FROM variants WHERE product_id = ?', pid);
    for (const [ci, c] of colors.entries()) for (const [si, s] of sizes.entries()) {
      const posted = b[`stock_${ci}_${si}`];
      const key = c.name + '|' + s;
      const val = posted !== undefined && posted !== '' ? Math.max(0, U.int(posted)) : key in existing ? existing[key] : defStock;
      await q.run('INSERT INTO variants(product_id,color,size,stock) VALUES(?,?,?,?)', pid, c.name, s, val);
    }
    if (id) {
      for (const iid of [].concat(b.delete_img || [])) {
        const row = await q.get('SELECT url FROM product_images WHERE id = ? AND product_id = ?', U.int(iid), pid);
        if (row) { await q.run('DELETE FROM product_images WHERE id = ?', U.int(iid)); toDelete.push(row.url); }
      }
      for (const r of await q.all('SELECT id FROM product_images WHERE product_id = ?', pid)) {
        const pos = b[`pos_${r.id}`]; if (pos !== undefined) await q.run('UPDATE product_images SET position = ? WHERE id = ?', U.int(pos), r.id);
      }
    }
    let next = (await q.get('SELECT COALESCE(MAX(position),0)+1 n FROM product_images WHERE product_id = ?', pid)).n;
    for (const url of uploaded) await q.run('INSERT INTO product_images(product_id,url,position) VALUES(?,?,?)', pid, url, next++);
  });
  toDelete.forEach((u) => storage.remove(u));
  res.flash('success', 'Product saved.');
  res.redirect(`/admin/products/${pid}`);
});

router.post('/products/:id/toggle', async (req, res) => {
  await db.run('UPDATE products SET active = 1 - active WHERE id = ?', U.int(req.params.id));
  back(req, res, '/admin/products');
});
router.post('/products/:id/quick', async (req, res) => { // inline price edit from the list
  const price = U.int(req.body.price), mrp = U.int(req.body.mrp);
  if (price > 0) await db.run('UPDATE products SET price = ?, mrp = ? WHERE id = ?', price, mrp || null, U.int(req.params.id));
  back(req, res, '/admin/products');
});
router.post('/products/:id/delete', async (req, res) => {
  const id = U.int(req.params.id);
  if (await db.get('SELECT 1 x FROM order_items WHERE product_id = ?', id)) {
    await db.run('UPDATE products SET active = 0 WHERE id = ?', id);
    res.flash('success', 'This product has past orders, so it was hidden instead of deleted.');
  } else {
    const imgs = await db.all('SELECT url FROM product_images WHERE product_id = ?', id);
    await db.run('DELETE FROM products WHERE id = ?', id);
    imgs.forEach((r) => storage.remove(r.url));
    res.flash('success', 'Product deleted.');
  }
  res.redirect('/admin/products');
});

/* ---------- Orders ---------- */
function orderQuery(req) {
  const where = ['1=1'], a = [];
  const st = req.query.status, pay = req.query.pay, q = U.str(req.query.q, 60);
  if (st && U.ORDER_STATUS[st]) { where.push('status = ?'); a.push(st); }
  if (pay && U.PAY_STATUS[pay]) { where.push('payment_status = ?'); a.push(pay); }
  if (q) { where.push('(number LIKE ? OR email LIKE ? OR name LIKE ? OR phone LIKE ?)'); a.push(...Array(4).fill(`%${q}%`)); }
  return { w: where.join(' AND '), a };
}
router.get('/orders', async (req, res) => {
  const { w, a } = orderQuery(req), page = Math.max(1, U.int(req.query.page, 1)), per = 20;
  const [tot, rows, cnt] = await Promise.all([
    db.get(`SELECT COUNT(*) c FROM orders WHERE ${w}`, ...a),
    db.all(`SELECT * FROM orders WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...a, per, (page - 1) * per),
    db.all('SELECT status, COUNT(*) c FROM orders GROUP BY status'),
  ]);
  const counts = {}; cnt.forEach((r) => (counts[r.status] = r.c));
  res.page('admin/orders', { title: 'Orders', rows, total: tot.c, page, pages: Math.max(1, Math.ceil(tot.c / per)), counts, st: req.query.status || '', pay: req.query.pay || '', q: req.query.q || '' });
});
router.get('/orders/export.csv', async (req, res) => {
  const { w, a } = orderQuery(req);
  const rows = await db.all(`SELECT * FROM orders WHERE ${w} ORDER BY id DESC`, ...a);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Order', 'Date', 'Customer', 'Email', 'Phone', 'City', 'State', 'PIN', 'Items', 'Subtotal', 'Discount', 'Shipping', 'COD fee', 'Total', 'Payment', 'Payment status', 'Status', 'Courier', 'Tracking']];
  for (const o of rows) {
    const s = U.jparse(o.ship, {});
    const its = (await orders.items(o.id)).map((i) => `${i.name} (${i.color}/${i.size}) x${i.qty}`).join('; ');
    lines.push([o.number, o.created_at, o.name, o.email, o.phone, s.city, s.state, s.pincode, its, o.subtotal, o.discount, o.shipping, o.cod_fee, o.total, o.payment_method, o.payment_status, o.status, o.carrier, o.tracking_no]);
  }
  res.type('text/csv').attachment('orders.csv').send('﻿' + lines.map((l) => l.map(cell).join(',')).join('\n'));
});
router.get('/orders/:number', async (req, res) => {
  const o = await orders.get(req.params.number);
  if (!o) return res.redirect('/admin/orders');
  res.page('admin/order', { title: `Order ${o.number}`, o, items: await orders.items(o.id), ship: U.jparse(o.ship, {}) });
});
router.post('/orders/:number', async (req, res) => {
  const o = await orders.get(req.params.number);
  if (!o) return res.redirect('/admin/orders');
  const status = U.ORDER_STATUS[req.body.status] ? req.body.status : o.status;
  const carrier = U.str(req.body.carrier, 60), tracking = U.str(req.body.tracking_no, 60);
  if (status === 'cancelled' && o.status !== 'cancelled') {
    await orders.cancel(o.number, { refunded: req.body.refunded === '1' });
    res.flash('success', 'Order cancelled and stock restored.' + (o.payment_status === 'paid' ? ' Remember to refund the customer in your payment gateway dashboard.' : ''));
    return res.redirect(`/admin/orders/${o.number}`);
  }
  let pay = U.PAY_STATUS[req.body.payment_status] ? req.body.payment_status : o.payment_status;
  if (status === 'delivered' && o.payment_method === 'cod' && pay === 'cod') pay = 'paid';
  const becamePaid = pay === 'paid' && o.payment_status !== 'paid';
  await db.run('UPDATE orders SET status=?, payment_status=?, carrier=?, tracking_no=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', status, pay, carrier || null, tracking || null, o.id);
  const fresh = await orders.get(o.number);
  if (becamePaid && o.payment_method !== 'cod' && o.status !== 'cancelled') await orders.finalize(fresh, base(req));
  if (req.body.notify === '1' && (status !== o.status || carrier !== (o.carrier || '') || tracking !== (o.tracking_no || ''))) await mail.statusUpdate(fresh, base(req));
  res.flash('success', 'Order updated.');
  res.redirect(`/admin/orders/${o.number}`);
});

/* ---------- Customers ---------- */
router.get('/customers', async (req, res) => {
  const [rows, subs] = await Promise.all([
    db.all(`SELECT u.*, COUNT(o.id) orders, COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total END),0) spent
      FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.role = 'customer' GROUP BY u.id ORDER BY u.id DESC`),
    db.get('SELECT COUNT(*) c FROM subscribers'),
  ]);
  res.page('admin/customers', { title: 'Customers', rows, subs: subs.c });
});
router.get('/subscribers.csv', async (req, res) => {
  const rows = await db.all('SELECT email, created_at FROM subscribers ORDER BY created_at DESC');
  res.type('text/csv').attachment('subscribers.csv').send('email,subscribed_at\n' + rows.map((r) => `${r.email},${r.created_at}`).join('\n'));
});

/* ---------- Reviews ---------- */
router.get('/reviews', async (req, res) => {
  const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const [rows, cnt] = await Promise.all([
    db.all(`SELECT r.*, p.name pname FROM reviews r LEFT JOIN products p ON p.id = r.product_id WHERE r.status = ? ORDER BY r.id DESC`, st),
    db.all('SELECT status, COUNT(*) c FROM reviews GROUP BY status'),
  ]);
  const counts = {}; cnt.forEach((r) => (counts[r.status] = r.c));
  res.page('admin/reviews', { title: 'Reviews', rows, st, counts });
});
router.post('/reviews/:id', async (req, res) => {
  const id = U.int(req.params.id);
  if (req.body.action === 'delete') await db.run('DELETE FROM reviews WHERE id = ?', id);
  else if (['approved', 'rejected'].includes(req.body.action)) await db.run('UPDATE reviews SET status = ? WHERE id = ?', req.body.action, id);
  back(req, res, '/admin/reviews');
});

/* ---------- Messages ---------- */
router.get('/messages', async (req, res) => {
  res.page('admin/messages', { title: 'Messages', rows: await db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 200') });
});
router.post('/messages/:id', async (req, res) => {
  const id = U.int(req.params.id);
  if (req.body.action === 'delete') await db.run('DELETE FROM messages WHERE id = ?', id);
  else await db.run('UPDATE messages SET status = ? WHERE id = ?', req.body.action === 'new' ? 'new' : 'done', id);
  back(req, res, '/admin/messages');
});

/* ---------- Coupons ---------- */
router.get('/coupons', async (req, res) => res.page('admin/coupons', { title: 'Coupons', rows: await db.all('SELECT * FROM coupons ORDER BY rowid DESC') }));
router.post('/coupons', async (req, res) => {
  const code = U.str(req.body.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = req.body.type === 'flat' ? 'flat' : 'percent', value = U.int(req.body.value);
  if (!code || value <= 0 || (type === 'percent' && value > 90)) { res.flash('error', 'Enter a code and a valid value (percent up to 90).'); return res.redirect('/admin/coupons'); }
  await db.run(`INSERT INTO coupons(code,type,value,min_order,max_uses,expires_at,active) VALUES(?,?,?,?,?,?,1)
    ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, min_order=excluded.min_order, max_uses=excluded.max_uses, expires_at=excluded.expires_at`,
    code, type, value, U.int(req.body.min_order), U.int(req.body.max_uses), req.body.expires_at || null);
  res.flash('success', 'Coupon saved.'); res.redirect('/admin/coupons');
});
router.post('/coupons/:code/toggle', async (req, res) => { await db.run('UPDATE coupons SET active = 1 - active WHERE code = ?', req.params.code); res.redirect('/admin/coupons'); });
router.post('/coupons/:code/delete', async (req, res) => { await db.run('DELETE FROM coupons WHERE code = ?', req.params.code); res.redirect('/admin/coupons'); });

/* ---------- Settings ---------- */
router.get('/settings', (req, res) => res.page('admin/settings', { title: 'Settings', pay: { razorpay: P.razorpay.enabled(), stripe: P.stripe.enabled(), demo: P.demo.enabled(), email: mail.emailEnabled() } }));
router.post('/settings', async (req, res) => {
  const b = req.body, v = {};
  ['store_name', 'tagline', 'email', 'phone', 'whatsapp', 'address', 'hours', 'instagram', 'facebook', 'announcement'].forEach((k) => (v[k] = U.str(b[k], 300)));
  ['shipping_fee', 'free_shipping_over', 'cod_fee', 'cod_max', 'return_days', 'low_stock'].forEach((k) => (v[k] = String(Math.max(0, U.int(b[k])))));
  v.whatsapp = v.whatsapp.replace(/[^0-9]/g, '');
  v.cod_enabled = b.cod_enabled ? '1' : '0';
  v.reviews_auto_approve = b.reviews_auto_approve ? '1' : '0';
  const rows = String(b.size_chart || '').split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()).slice(0, 4)).filter((r) => r.length >= 2 && r[0]);
  if (rows.length) v.size_chart = JSON.stringify(rows);
  if (!v.store_name) v.store_name = 'OJAS';
  await setSettings(v);
  res.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
