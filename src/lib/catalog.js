const { db } = require('../db');
const { jparse } = require('./util');

function hydrate(r) {
  if (!r) return null;
  return { ...r, colors: jparse(r.colors, []), sizes: jparse(r.sizes, []), extras: jparse(r.extras, []) };
}

function attach(products) {
  if (!products.length) return products;
  const ids = products.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');
  const imgs = db.prepare(`SELECT product_id, url FROM product_images WHERE product_id IN (${ph}) ORDER BY position, id`).all(...ids);
  const rt = db.prepare(`SELECT product_id, AVG(rating) avg, COUNT(*) n FROM reviews WHERE status='approved' AND product_id IN (${ph}) GROUP BY product_id`).all(...ids);
  const stock = db.prepare(`SELECT product_id, SUM(stock) s FROM variants WHERE product_id IN (${ph}) GROUP BY product_id`).all(...ids);
  const im = {}, rm = {}, sm = {};
  imgs.forEach((i) => (im[i.product_id] ||= []).push(i.url));
  rt.forEach((r) => (rm[r.product_id] = r));
  stock.forEach((s) => (sm[s.product_id] = s.s));
  products.forEach((p) => {
    p.images = im[p.id] || [];
    p.rating = rm[p.id] ? Math.round(rm[p.id].avg * 10) / 10 : 0;
    p.reviewCount = rm[p.id] ? rm[p.id].n : 0;
    p.totalStock = sm[p.id] || 0;
    p.discount = p.mrp && p.mrp > p.price ? Math.round((1 - p.price / p.mrp) * 100) : 0;
  });
  return products;
}

function getBySlug(slug, includeInactive = false) {
  const r = db.prepare(`SELECT * FROM products WHERE slug = ? ${includeInactive ? '' : 'AND active = 1'}`).get(slug);
  return r ? attach([hydrate(r)])[0] : null;
}
function getById(id) {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  return r ? attach([hydrate(r)])[0] : null;
}

function list(opts = {}) {
  const where = ['p.active = 1'], args = [];
  if (opts.category) { where.push('p.category = ?'); args.push(opts.category); }
  if (opts.q) {
    const terms = opts.q.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const t of terms) { where.push('(p.name LIKE ? OR p.code LIKE ? OR p.category LIKE ? OR p.description LIKE ? OR p.colors LIKE ?)'); const l = `%${t}%`; args.push(l, l, l, l, l); }
  }
  if (opts.min != null) { where.push('p.price >= ?'); args.push(opts.min); }
  if (opts.max != null) { where.push('p.price <= ?'); args.push(opts.max); }
  if (opts.featured) where.push('p.featured = 1');
  if (opts.isNew) where.push('p.is_new = 1');
  if (opts.sale) where.push('p.mrp > p.price');
  const vc = [];
  if (opts.colors && opts.colors.length) { vc.push(`v.color IN (${opts.colors.map(() => '?').join(',')})`); args.push(...opts.colors); }
  if (opts.sizes && opts.sizes.length) { vc.push(`v.size IN (${opts.sizes.map(() => '?').join(',')})`); args.push(...opts.sizes); }
  if (vc.length) where.push(`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.stock > 0 AND ${vc.join(' AND ')})`);
  const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC', newest: 'p.id DESC', popular: 'p.sold DESC, p.featured DESC', name: 'p.name ASC' }[opts.sort] || 'p.sort ASC, p.id ASC';
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM products p WHERE ${w}`).get(...args).c;
  const per = opts.perPage || 12, page = Math.max(1, opts.page || 1);
  const rows = db.prepare(`SELECT p.* FROM products p WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
  return { items: attach(rows.map(hydrate)), total, page, pages: Math.max(1, Math.ceil(total / per)), per };
}

// colours + sizes + price range available across the active catalogue (for the filter sidebar)
function facets() {
  const rows = db.prepare('SELECT colors, sizes, price FROM products WHERE active = 1').all();
  const colors = new Map(), sizes = new Set();
  let min = Infinity, max = 0;
  for (const r of rows) {
    jparse(r.colors, []).forEach((c) => { if (!colors.has(c.name)) colors.set(c.name, c.hex); });
    jparse(r.sizes, []).forEach((s) => sizes.add(s));
    min = Math.min(min, r.price); max = Math.max(max, r.price);
  }
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
  return {
    colors: [...colors].map(([name, hex]) => ({ name, hex })).sort((a, b) => a.name.localeCompare(b.name)),
    sizes: [...sizes].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    min: min === Infinity ? 0 : min, max,
  };
}

function variantsFor(productId) {
  return db.prepare('SELECT color, size, stock FROM variants WHERE product_id = ?').all(productId);
}
function categoryCounts() {
  const m = {};
  db.prepare('SELECT category, COUNT(*) c FROM products WHERE active = 1 GROUP BY category').all().forEach((r) => (m[r.category] = r.c));
  return m;
}
function categoryCovers() {
  const m = {};
  db.prepare(`SELECT p.category, (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY position LIMIT 1) url FROM products p WHERE p.active = 1 ORDER BY p.featured DESC, p.id`).all()
    .forEach((r) => { if (!m[r.category] && r.url) m[r.category] = r.url; });
  return m;
}

module.exports = { hydrate, attach, getBySlug, getById, list, facets, variantsFor, categoryCounts, categoryCovers };
