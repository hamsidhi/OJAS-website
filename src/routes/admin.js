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

router.use((req, res, next) => {
  if (!req.user) { res.flash('error', 'Please sign in with your admin account.'); return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); }
  if (req.user.role !== 'admin') return res.status(403).page('error', { title: 'Not allowed', code: 403, message: 'This area is for store admins only.' });
  res.locals.adminPath = req.path;
  next();
});

const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + U.token(4) + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});
const base = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const back = (req, res, fallback) => res.redirect(req.get('referer') || fallback);

/* ---------- Dashboard ---------- */
router.get('/', (req, res) => {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const live = "status != 'cancelled'";
  const stats = {
    revenue: q(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${live}`).v,
    revenue30: q(`SELECT COALESCE(SUM(total),0) v FROM orders WHERE ${live} AND created_at > datetime('now','-30 days')`).v,
    orders: q(`SELECT COUNT(*) v FROM orders WHERE ${live}`).v,
    today: q(`SELECT COUNT(*) v FROM orders WHERE ${live} AND date(created_at) = date('now')`).v,
    toShip: q(`SELECT COUNT(*) v FROM orders WHERE status = 'processing'`).v,
    customers: q(`SELECT COUNT(*) v FROM users WHERE role = 'customer'`).v,
    pendingReviews: q(`SELECT COUNT(*) v FROM reviews WHERE status = 'pending'`).v,
    newMessages: q(`SELECT COUNT(*) v FROM messages WHERE status = 'new'`).v,
    lowStock: q('SELECT COUNT(*) v FROM variants v JOIN products p ON p.id = v.product_id WHERE p.active = 1 AND v.stock <= ?', U.int(getSettings().low_stock, 5)).v,
    products: q('SELECT COUNT(*) v FROM products WHERE active = 1').v,
  };
  const recent = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();
  const top = db.prepare('SELECT id, name, code, sold FROM products WHERE sold > 0 ORDER BY sold DESC LIMIT 5').all();
  const s = getSettings();
  const checklist = [
    { done: s.email !== DEFAULT_SETTINGS.email && s.phone !== DEFAULT_SETTINGS.phone, text: 'Add your real email, phone, WhatsApp and address', link: '/admin/settings' },
    { done: P.razorpay.enabled() || P.stripe.enabled(), text: 'Connect a payment gateway (Razorpay or Stripe keys in .env)', link: '/admin/settings#payments' },
    { done: mail.emailEnabled(), text: 'Set up SMTP so order emails are sent (in .env)' },
    { done: !P.demo.enabled(), text: 'Turn off demo payments before going live (DEMO_PAYMENTS=false)' },
    { done: process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== 'ChangeMe123!', text: 'Change the default admin password (Account > Profile)', link: '/account#profile' },
    { done: !!db.prepare("SELECT 1 FROM settings WHERE key = 'pricing_reviewed'").get(), text: 'Review prices and stock for all products (starting prices are placeholders)', link: '/admin/products?reviewed=1' },
  ];
  res.page('admin/dashboard', { title: 'Dashboard', stats, recent, top, checklist });
});

/* ---------- Products ---------- */
router.get('/products', (req, res) => {
  if (req.query.reviewed === '1') db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('pricing_reviewed','1')").run();
  const q = U.str(req.query.q, 60), cat = U.CATEGORIES.includes(req.query.cat) ? req.query.cat : '';
  const where = ['1=1'], a = [];
  if (q) { where.push('(name LIKE ? OR code LIKE ?)'); a.push(`%${q}%`, `%${q}%`); }
  if (cat) { where.push('category = ?'); a.push(cat); }
  if (req.query.low === '1') where.push('id IN (SELECT product_id FROM variants GROUP BY product_id HAVING MIN(stock) <= ' + U.int(getSettings().low_stock, 5) + ')');
  const rows = C.attach(db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...a).map(C.hydrate));
  res.page('admin/products', { title: 'Products', rows, q, cat });
});

function productForm(req, res, p) {
  const variants = p ? C.variantsFor(p.id) : [];
  const stock = {}; variants.forEach((v) => (stock[v.color + '|' + v.size] = v.stock));
  res.page('admin/product-form', { title: p ? 'Edit product' : 'New product', p, stock, allSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] });
}
router.get('/products/new', (req, res) => productForm(req, res, null));
router.get('/products/:id', (req, res) => {
  const p = C.getById(U.int(req.params.id));
  if (!p) return res.redirect('/admin/products');
  p.imageRows = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id').all(p.id);
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

router.post('/products/save', upload.array('images', 10), (req, res) => {
  const b = req.body, id = U.int(b.id);
  const colors = parseColors(b.colors);
  const sizes = [...new Set(String(b.sizes || '').split(/[\s,\/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  const name = U.str(b.name, 120), code = U.str(b.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const price = U.int(b.price), mrp = U.int(b.mrp);
  const err = !name ? 'Name is required.' : !code ? 'Style code is required.' : !U.CATEGORIES.includes(b.category) ? 'Choose a category.' : price <= 0 ? 'Enter a valid price.'
    : !colors.length ? 'Add at least one colour.' : !sizes.length ? 'Add at least one size.' : null;
  const fail = (m) => { (req.files || []).forEach((f) => fs.unlink(f.path, () => {})); res.flash('error', m); return res.redirect(id ? `/admin/products/${id}` : '/admin/products/new'); };
  if (err) return fail(err);
  const extras = String(b.extras || '').split(/\r?\n/).map((l) => l.split(':')).filter((x) => x.length >= 2 && x[0].trim()).map((x) => [x[0].trim().slice(0, 30), x.slice(1).join(':').trim().slice(0, 120)]);
  const slug = U.slugify(code);
  const dup = db.prepare('SELECT id FROM products WHERE (code = ? OR slug = ?) AND id != ?').get(code, slug, id);
  if (dup) return fail('Another product already uses that style code.');
  const defStock = Math.max(0, U.int(b.default_stock, 0));
  let pid = id;
  tx(() => {
    const vals = [code, slug, name, b.category, U.str(b.description, 2000), U.str(b.composition, 200), JSON.stringify(extras), JSON.stringify(colors), JSON.stringify(sizes), price, mrp || null, b.active ? 1 : 0, b.featured ? 1 : 0, b.is_new ? 1 : 0];
    if (id) {
      db.prepare('UPDATE products SET code=?,slug=?,name=?,category=?,description=?,composition=?,extras=?,colors=?,sizes=?,price=?,mrp=?,active=?,featured=?,is_new=? WHERE id=?').run(...vals, id);
    } else {
      pid = Number(db.prepare('INSERT INTO products(code,slug,name,category,description,composition,extras,colors,sizes,price,mrp,active,featured,is_new) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
    }
    // sync variants (keep existing stock, apply grid inputs, default for new combos)
    const existing = {}; db.prepare('SELECT color,size,stock FROM variants WHERE product_id = ?').all(pid).forEach((v) => (existing[v.color + '|' + v.size] = v.stock));
    db.prepare('DELETE FROM variants WHERE product_id = ?').run(pid);
    const ins = db.prepare('INSERT INTO variants(product_id,color,size,stock) VALUES(?,?,?,?)');
    colors.forEach((c, ci) => sizes.forEach((s, si) => {
      const posted = b[`stock_${ci}_${si}`];
      const key = c.name + '|' + s;
      const val = posted !== undefined && posted !== '' ? Math.max(0, U.int(posted)) : key in existing ? existing[key] : defStock;
      ins.run(pid, c.name, s, val);
    }));
    // images
    if (id) {
      [].concat(b.delete_img || []).forEach((iid) => {
        const row = db.prepare('SELECT url FROM product_images WHERE id = ? AND product_id = ?').get(U.int(iid), pid);
        if (row) { db.prepare('DELETE FROM product_images WHERE id = ?').run(U.int(iid)); if (row.url.startsWith('/uploads/')) fs.unlink(path.join(uploadDir, path.basename(row.url)), () => {}); }
      });
      db.prepare('SELECT id FROM product_images WHERE product_id = ?').all(pid).forEach((r) => {
        const pos = b[`pos_${r.id}`]; if (pos !== undefined) db.prepare('UPDATE product_images SET position = ? WHERE id = ?').run(U.int(pos), r.id);
      });
    }
    let next = (db.prepare('SELECT COALESCE(MAX(position),0)+1 n FROM product_images WHERE product_id = ?').get(pid)).n;
    (req.files || []).forEach((f) => db.prepare('INSERT INTO product_images(product_id,url,position) VALUES(?,?,?)').run(pid, '/uploads/' + f.filename, next++));
  });
  res.flash('success', 'Product saved.');
  res.redirect(`/admin/products/${pid}`);
});

router.post('/products/:id/toggle', (req, res) => {
  db.prepare('UPDATE products SET active = 1 - active WHERE id = ?').run(U.int(req.params.id));
  back(req, res, '/admin/products');
});
router.post('/products/:id/quick', (req, res) => { // inline price edit from the list
  const price = U.int(req.body.price), mrp = U.int(req.body.mrp);
  if (price > 0) db.prepare('UPDATE products SET price = ?, mrp = ? WHERE id = ?').run(price, mrp || null, U.int(req.params.id));
  back(req, res, '/admin/products');
});
router.post('/products/:id/delete', (req, res) => {
  const id = U.int(req.params.id);
  if (db.prepare('SELECT 1 FROM order_items WHERE product_id = ?').get(id)) {
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
    res.flash('success', 'This product has past orders, so it was hidden instead of deleted.');
  } else {
    db.prepare('SELECT url FROM product_images WHERE product_id = ?').all(id).forEach((r) => r.url.startsWith('/uploads/') && fs.unlink(path.join(uploadDir, path.basename(r.url)), () => {}));
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
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
router.get('/orders', (req, res) => {
  const { w, a } = orderQuery(req), page = Math.max(1, U.int(req.query.page, 1)), per = 20;
  const total = db.prepare(`SELECT COUNT(*) c FROM orders WHERE ${w}`).get(...a).c;
  const rows = db.prepare(`SELECT * FROM orders WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, per, (page - 1) * per);
  const counts = {}; db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all().forEach((r) => (counts[r.status] = r.c));
  res.page('admin/orders', { title: 'Orders', rows, total, page, pages: Math.max(1, Math.ceil(total / per)), counts, st: req.query.status || '', pay: req.query.pay || '', q: req.query.q || '' });
});
router.get('/orders/export.csv', (req, res) => {
  const { w, a } = orderQuery(req);
  const rows = db.prepare(`SELECT * FROM orders WHERE ${w} ORDER BY id DESC`).all(...a);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Order', 'Date', 'Customer', 'Email', 'Phone', 'City', 'State', 'PIN', 'Items', 'Subtotal', 'Discount', 'Shipping', 'COD fee', 'Total', 'Payment', 'Payment status', 'Status', 'Courier', 'Tracking']];
  rows.forEach((o) => { const s = U.jparse(o.ship, {}); const its = orders.items(o.id).map((i) => `${i.name} (${i.color}/${i.size}) x${i.qty}`).join('; ');
    lines.push([o.number, o.created_at, o.name, o.email, o.phone, s.city, s.state, s.pincode, its, o.subtotal, o.discount, o.shipping, o.cod_fee, o.total, o.payment_method, o.payment_status, o.status, o.carrier, o.tracking_no]); });
  res.type('text/csv').attachment('orders.csv').send('﻿' + lines.map((l) => l.map(cell).join(',')).join('\n'));
});
router.get('/orders/:number', (req, res) => {
  const o = orders.get(req.params.number);
  if (!o) return res.redirect('/admin/orders');
  res.page('admin/order', { title: `Order ${o.number}`, o, items: orders.items(o.id), ship: U.jparse(o.ship, {}) });
});
router.post('/orders/:number', async (req, res) => {
  const o = orders.get(req.params.number);
  if (!o) return res.redirect('/admin/orders');
  const status = U.ORDER_STATUS[req.body.status] ? req.body.status : o.status;
  const carrier = U.str(req.body.carrier, 60), tracking = U.str(req.body.tracking_no, 60);
  if (status === 'cancelled' && o.status !== 'cancelled') {
    orders.cancel(o.number, { refunded: req.body.refunded === '1' });
    res.flash('success', 'Order cancelled and stock restored.' + (o.payment_status === 'paid' ? ' Remember to refund the customer in your payment gateway dashboard.' : ''));
    return res.redirect(`/admin/orders/${o.number}`);
  }
  let pay = U.PAY_STATUS[req.body.payment_status] ? req.body.payment_status : o.payment_status;
  if (status === 'delivered' && o.payment_method === 'cod' && pay === 'cod') pay = 'paid';
  const becamePaid = pay === 'paid' && o.payment_status !== 'paid';
  db.prepare('UPDATE orders SET status=?, payment_status=?, carrier=?, tracking_no=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, pay, carrier || null, tracking || null, o.id);
  const fresh = orders.get(o.number);
  if (becamePaid && o.payment_method !== 'cod' && o.status !== 'cancelled') orders.finalize(fresh, base(req));
  if (req.body.notify === '1' && (status !== o.status || carrier !== (o.carrier || '') || tracking !== (o.tracking_no || ''))) { await mail.statusUpdate(fresh, base(req)); }
  res.flash('success', 'Order updated.');
  res.redirect(`/admin/orders/${o.number}`);
});

/* ---------- Customers ---------- */
router.get('/customers', (req, res) => {
  const rows = db.prepare(`SELECT u.*, COUNT(o.id) orders, COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total END),0) spent
    FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.role = 'customer' GROUP BY u.id ORDER BY u.id DESC`).all();
  const subs = db.prepare('SELECT COUNT(*) c FROM subscribers').get().c;
  res.page('admin/customers', { title: 'Customers', rows, subs });
});
router.get('/subscribers.csv', (req, res) => {
  const rows = db.prepare('SELECT email, created_at FROM subscribers ORDER BY created_at DESC').all();
  res.type('text/csv').attachment('subscribers.csv').send('email,subscribed_at\n' + rows.map((r) => `${r.email},${r.created_at}`).join('\n'));
});

/* ---------- Reviews ---------- */
router.get('/reviews', (req, res) => {
  const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT r.*, p.name pname FROM reviews r LEFT JOIN products p ON p.id = r.product_id WHERE r.status = ? ORDER BY r.id DESC`).all(st);
  const counts = {}; db.prepare('SELECT status, COUNT(*) c FROM reviews GROUP BY status').all().forEach((r) => (counts[r.status] = r.c));
  res.page('admin/reviews', { title: 'Reviews', rows, st, counts });
});
router.post('/reviews/:id', (req, res) => {
  const id = U.int(req.params.id);
  if (req.body.action === 'delete') db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  else if (['approved', 'rejected'].includes(req.body.action)) db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(req.body.action, id);
  back(req, res, '/admin/reviews');
});

/* ---------- Messages ---------- */
router.get('/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all();
  res.page('admin/messages', { title: 'Messages', rows });
});
router.post('/messages/:id', (req, res) => {
  const id = U.int(req.params.id);
  if (req.body.action === 'delete') db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  else db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(req.body.action === 'new' ? 'new' : 'done', id);
  back(req, res, '/admin/messages');
});

/* ---------- Coupons ---------- */
router.get('/coupons', (req, res) => res.page('admin/coupons', { title: 'Coupons', rows: db.prepare('SELECT * FROM coupons ORDER BY rowid DESC').all() }));
router.post('/coupons', (req, res) => {
  const code = U.str(req.body.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = req.body.type === 'flat' ? 'flat' : 'percent', value = U.int(req.body.value);
  if (!code || value <= 0 || (type === 'percent' && value > 90)) { res.flash('error', 'Enter a code and a valid value (percent up to 90).'); return res.redirect('/admin/coupons'); }
  db.prepare(`INSERT INTO coupons(code,type,value,min_order,max_uses,expires_at,active) VALUES(?,?,?,?,?,?,1)
    ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, min_order=excluded.min_order, max_uses=excluded.max_uses, expires_at=excluded.expires_at`)
    .run(code, type, value, U.int(req.body.min_order), U.int(req.body.max_uses), req.body.expires_at || null);
  res.flash('success', 'Coupon saved.'); res.redirect('/admin/coupons');
});
router.post('/coupons/:code/toggle', (req, res) => { db.prepare('UPDATE coupons SET active = 1 - active WHERE code = ?').run(req.params.code); res.redirect('/admin/coupons'); });
router.post('/coupons/:code/delete', (req, res) => { db.prepare('DELETE FROM coupons WHERE code = ?').run(req.params.code); res.redirect('/admin/coupons'); });

/* ---------- Settings ---------- */
router.get('/settings', (req, res) => res.page('admin/settings', { title: 'Settings', pay: { razorpay: P.razorpay.enabled(), stripe: P.stripe.enabled(), demo: P.demo.enabled(), email: mail.emailEnabled() } }));
router.post('/settings', (req, res) => {
  const b = req.body, v = {};
  ['store_name', 'tagline', 'email', 'phone', 'whatsapp', 'address', 'hours', 'instagram', 'facebook', 'announcement'].forEach((k) => (v[k] = U.str(b[k], 300)));
  ['shipping_fee', 'free_shipping_over', 'cod_fee', 'cod_max', 'return_days', 'low_stock'].forEach((k) => (v[k] = String(Math.max(0, U.int(b[k])))));
  v.whatsapp = v.whatsapp.replace(/[^0-9]/g, '');
  v.cod_enabled = b.cod_enabled ? '1' : '0';
  v.reviews_auto_approve = b.reviews_auto_approve ? '1' : '0';
  // size chart: one row per line "S, 33-34, 26-27, 36-37"
  const rows = String(b.size_chart || '').split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()).slice(0, 4)).filter((r) => r.length >= 2 && r[0]);
  if (rows.length) v.size_chart = JSON.stringify(rows);
  if (!v.store_name) v.store_name = 'OJAS';
  setSettings(v);
  res.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
