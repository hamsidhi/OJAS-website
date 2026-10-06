const router = require('express').Router();
const { db, getSettings } = require('../db');
const C = require('../lib/catalog');
const U = require('../lib/util');

const arr = (v) => (v == null ? [] : [].concat(v)).map(String).filter(Boolean);

router.get('/', (req, res) => {
  const newest = C.list({ sort: 'newest', perPage: 8 }).items;
  const best = C.list({ sort: 'popular', perPage: 8 }).items;
  const feat = C.list({ featured: true, perPage: 4 }).items;
  const counts = C.categoryCounts(), covers = C.categoryCovers();
  const reviews = db.prepare(`SELECT r.*, p.name pname, p.slug pslug FROM reviews r LEFT JOIN products p ON p.id = r.product_id
    WHERE r.status = 'approved' AND r.rating >= 4 ORDER BY r.id DESC LIMIT 6`).all();
  const stats = db.prepare(`SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE status='approved'`).get();
  res.page('home', { title: `${getSettings().store_name} - ${getSettings().tagline}`,
    metaDesc: 'Premium activewear for women: sports bras, leggings, tennis skirts, jackets and more.', newest, best, feat, counts, covers, reviews, stats });
});

router.get(['/shop', '/shop/:cat'], (req, res) => {
  const q = U.str(req.query.q, 80);
  const cat = req.params.cat ? U.catFromSlug(req.params.cat) : U.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  if (req.params.cat && !cat) return res.redirect('/shop');
  const colors = arr(req.query.color), sizes = arr(req.query.size);
  const min = req.query.min !== undefined && req.query.min !== '' ? U.int(req.query.min) : null;
  const max = req.query.max !== undefined && req.query.max !== '' ? U.int(req.query.max) : null;
  const sort = ['price_asc', 'price_desc', 'newest', 'popular', 'name'].includes(req.query.sort) ? req.query.sort : '';
  const page = Math.max(1, U.int(req.query.page, 1));
  const r = C.list({ category: cat, q, colors, sizes, min, max, sort, page, perPage: 12, sale: req.query.sale === '1', isNew: req.query.new === '1' });
  const wish = req.user ? new Set(db.prepare('SELECT product_id FROM wishlist WHERE user_id = ?').all(req.user.id).map((x) => x.product_id)) : new Set();
  const heading = q ? `Results for "${q}"` : req.query.sale === '1' ? 'Sale' : req.query.new === '1' ? 'New Arrivals' : cat || 'All Products';
  res.page('shop', { title: `${heading} | ${getSettings().store_name}`, metaDesc: `Shop ${heading.toLowerCase()} at ${getSettings().store_name}.`,
    heading, cat, q, colors, sizes, min, max, sort, r, facets: C.facets(), counts: C.categoryCounts(), wish });
});

router.get('/api/search', (req, res) => {
  const q = U.str(req.query.q, 60);
  if (q.length < 2) return res.json([]);
  res.json(C.list({ q, perPage: 6 }).items.map((p) => ({ name: p.name, slug: p.slug, price: p.price, category: p.category, image: p.images[0] })));
});

router.get('/product/:slug', (req, res) => {
  const p = C.getBySlug(req.params.slug);
  if (!p) return res.status(404).page('error', { title: 'Not found', code: 404, message: 'This product is not available.' });
  const variants = C.variantsFor(p.id);
  const reviews = db.prepare(`SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 50`).all(p.id);
  const dist = [0, 0, 0, 0, 0, 0];
  reviews.forEach((r) => dist[r.rating]++);
  const related = C.list({ category: p.category, perPage: 5 }).items.filter((x) => x.id !== p.id).slice(0, 4);
  const inWish = req.user ? !!db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(req.user.id, p.id) : false;
  let canReview = false, myReview = null;
  if (req.user) {
    myReview = db.prepare('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(p.id, req.user.id);
    canReview = !myReview;
  }
  const bought = req.user && !!db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.product_id = ? AND o.status != 'cancelled'`).get(req.user.id, p.id);
  const sizeChart = U.jparse(getSettings().size_chart, []);
  const lowAt = U.int(getSettings().low_stock, 5);
  res.page('product', { title: `${p.name} | ${getSettings().store_name}`, metaDesc: p.description, ogImage: p.images[0], p, variants, reviews, dist, related, inWish, canReview, myReview, bought, sizeChart, lowAt });
});

router.post('/product/:slug/review', (req, res) => {
  const p = C.getBySlug(req.params.slug);
  if (!p) return res.redirect('/shop');
  if (!req.user) { res.flash('error', 'Please sign in to write a review.'); return res.redirect(`/login?next=${encodeURIComponent('/product/' + p.slug)}`); }
  const rating = U.int(req.body.rating);
  const body = U.str(req.body.body, 1500), title = U.str(req.body.title, 100);
  if (rating < 1 || rating > 5 || body.length < 5) { res.flash('error', 'Please choose a star rating and write a few words.'); return res.redirect(`/product/${p.slug}#reviews`); }
  if (db.prepare('SELECT 1 FROM reviews WHERE product_id = ? AND user_id = ?').get(p.id, req.user.id)) { res.flash('error', 'You have already reviewed this product.'); return res.redirect(`/product/${p.slug}#reviews`); }
  const verified = db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.product_id = ? AND o.status != 'cancelled'`).get(req.user.id, p.id) ? 1 : 0;
  const auto = getSettings().reviews_auto_approve === '1';
  db.prepare('INSERT INTO reviews(product_id,user_id,name,rating,title,body,verified,status) VALUES(?,?,?,?,?,?,?,?)')
    .run(p.id, req.user.id, req.user.name.split(' ')[0] + (req.user.name.split(' ')[1] ? ' ' + req.user.name.split(' ')[1][0] + '.' : ''), rating, title, body, verified, auto ? 'approved' : 'pending');
  res.flash('success', auto ? 'Thank you! Your review is live.' : 'Thank you! Your review will appear after approval.');
  res.redirect(`/product/${p.slug}#reviews`);
});

router.get('/wishlist', (req, res) => {
  if (!req.user) { res.flash('error', 'Sign in to see your wishlist.'); return res.redirect('/login?next=/wishlist'); }
  const ids = db.prepare('SELECT product_id FROM wishlist WHERE user_id = ? ORDER BY rowid DESC').all(req.user.id).map((x) => x.product_id);
  const items = ids.map((id) => C.getById(id)).filter((p) => p && p.active);
  res.page('wishlist', { title: 'My Wishlist', items, wish: new Set(ids) });
});

router.post('/wishlist/toggle', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, login: true, error: 'Please sign in to save favourites.' });
  const pid = U.int(req.body.pid);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) return res.status(404).json({ ok: false });
  const has = db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?').get(req.user.id, pid);
  if (has) db.prepare('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?').run(req.user.id, pid);
  else db.prepare('INSERT INTO wishlist(user_id,product_id) VALUES(?,?)').run(req.user.id, pid);
  res.json({ ok: true, saved: !has });
});

module.exports = router;
