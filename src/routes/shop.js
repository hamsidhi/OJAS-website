const router = require('express').Router();
const { db, getSettings } = require('../db');
const C = require('../lib/catalog');
const U = require('../lib/util');

const arr = (v) => (v == null ? [] : [].concat(v)).map(String).filter(Boolean);

router.get('/', async (req, res) => {
  const [newestR, bestR, featR, counts, covers, reviews, stats] = await Promise.all([
    C.list({ sort: 'newest', perPage: 8 }), C.list({ sort: 'popular', perPage: 8 }), C.list({ featured: true, perPage: 4 }),
    C.categoryCounts(), C.categoryCovers(),
    db.all(`SELECT r.*, p.name pname, p.slug pslug FROM reviews r LEFT JOIN products p ON p.id = r.product_id
      WHERE r.status = 'approved' AND r.rating >= 4 ORDER BY r.id DESC LIMIT 6`),
    db.get(`SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE status='approved'`),
  ]);
  res.page('home', { title: `${getSettings().store_name} - ${getSettings().tagline}`,
    metaDesc: 'Premium activewear for women: sports bras, leggings, tennis skirts, jackets and more.',
    newest: newestR.items, best: bestR.items, feat: featR.items, counts, covers, reviews, stats });
});

router.get(['/shop', '/shop/:cat'], async (req, res) => {
  const q = U.str(req.query.q, 80);
  const cat = req.params.cat ? U.catFromSlug(req.params.cat) : U.CATEGORIES.includes(req.query.category) ? req.query.category : null;
  if (req.params.cat && !cat) return res.redirect('/shop');
  const colors = arr(req.query.color), sizes = arr(req.query.size);
  const min = req.query.min !== undefined && req.query.min !== '' ? U.int(req.query.min) : null;
  const max = req.query.max !== undefined && req.query.max !== '' ? U.int(req.query.max) : null;
  const sort = ['price_asc', 'price_desc', 'newest', 'popular', 'name'].includes(req.query.sort) ? req.query.sort : '';
  const page = Math.max(1, U.int(req.query.page, 1));
  const [r, facets, counts, wishRows] = await Promise.all([
    C.list({ category: cat, q, colors, sizes, min, max, sort, page, perPage: 12, sale: req.query.sale === '1', isNew: req.query.new === '1' }),
    C.facets(), C.categoryCounts(),
    req.user ? db.all('SELECT product_id FROM wishlist WHERE user_id = ?', req.user.id) : [],
  ]);
  const wish = new Set(wishRows.map((x) => x.product_id));
  const heading = q ? `Results for "${q}"` : req.query.sale === '1' ? 'Sale' : req.query.new === '1' ? 'New Arrivals' : cat || 'All Products';
  res.page('shop', { title: `${heading} | ${getSettings().store_name}`, metaDesc: `Shop ${heading.toLowerCase()} at ${getSettings().store_name}.`,
    heading, cat, q, colors, sizes, min, max, sort, r, facets, counts, wish });
});

router.get('/api/search', async (req, res) => {
  const q = U.str(req.query.q, 60);
  if (q.length < 2) return res.json([]);
  const r = await C.list({ q, perPage: 6 });
  res.json(r.items.map((p) => ({ name: p.name, slug: p.slug, price: p.price, category: p.category, image: p.images[0] })));
});

router.get('/product/:slug', async (req, res) => {
  const p = await C.getBySlug(req.params.slug);
  if (!p) return res.status(404).page('error', { title: 'Not found', code: 404, message: 'This product is not available.' });
  const [variants, reviews, relatedR, wishRow, myReview, boughtRow] = await Promise.all([
    C.variantsFor(p.id),
    db.all(`SELECT * FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 50`, p.id),
    C.list({ category: p.category, perPage: 5 }),
    req.user ? db.get('SELECT 1 x FROM wishlist WHERE user_id = ? AND product_id = ?', req.user.id, p.id) : null,
    req.user ? db.get('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?', p.id, req.user.id) : null,
    req.user ? db.get(`SELECT 1 x FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.product_id = ? AND o.status != 'cancelled'`, req.user.id, p.id) : null,
  ]);
  const dist = [0, 0, 0, 0, 0, 0];
  reviews.forEach((r) => dist[r.rating]++);
  const related = relatedR.items.filter((x) => x.id !== p.id).slice(0, 4);
  const sizeChart = U.jparse(getSettings().size_chart, []);
  const lowAt = U.int(getSettings().low_stock, 5);
  res.page('product', { title: `${p.name} | ${getSettings().store_name}`, metaDesc: p.description, ogImage: p.images[0], p, variants, reviews, dist, related,
    inWish: !!wishRow, canReview: !!req.user && !myReview, myReview: myReview || null, bought: !!boughtRow, sizeChart, lowAt });
});

router.post('/product/:slug/review', async (req, res) => {
  const p = await C.getBySlug(req.params.slug);
  if (!p) return res.redirect('/shop');
  if (!req.user) { res.flash('error', 'Please sign in to write a review.'); return res.redirect(`/login?next=${encodeURIComponent('/product/' + p.slug)}`); }
  const rating = U.int(req.body.rating);
  const body = U.str(req.body.body, 1500), title = U.str(req.body.title, 100);
  if (rating < 1 || rating > 5 || body.length < 5) { res.flash('error', 'Please choose a star rating and write a few words.'); return res.redirect(`/product/${p.slug}#reviews`); }
  if (await db.get('SELECT 1 x FROM reviews WHERE product_id = ? AND user_id = ?', p.id, req.user.id)) { res.flash('error', 'You have already reviewed this product.'); return res.redirect(`/product/${p.slug}#reviews`); }
  const verified = (await db.get(`SELECT 1 x FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? AND oi.product_id = ? AND o.status != 'cancelled'`, req.user.id, p.id)) ? 1 : 0;
  const auto = getSettings().reviews_auto_approve === '1';
  const parts = req.user.name.split(' ');
  await db.run('INSERT INTO reviews(product_id,user_id,name,rating,title,body,verified,status) VALUES(?,?,?,?,?,?,?,?)',
    p.id, req.user.id, parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : ''), rating, title, body, verified, auto ? 'approved' : 'pending');
  res.flash('success', auto ? 'Thank you! Your review is live.' : 'Thank you! Your review will appear after approval.');
  res.redirect(`/product/${p.slug}#reviews`);
});

router.get('/wishlist', async (req, res) => {
  if (!req.user) { res.flash('error', 'Sign in to see your wishlist.'); return res.redirect('/login?next=/wishlist'); }
  const ids = (await db.all('SELECT product_id FROM wishlist WHERE user_id = ? ORDER BY rowid DESC', req.user.id)).map((x) => x.product_id);
  const items = (await Promise.all(ids.map((id) => C.getById(id)))).filter((p) => p && p.active);
  res.page('wishlist', { title: 'My Wishlist', items, wish: new Set(ids) });
});

router.post('/wishlist/toggle', async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, login: true, error: 'Please sign in to save favourites.' });
  const pid = U.int(req.body.pid);
  if (!(await db.get('SELECT 1 x FROM products WHERE id = ?', pid))) return res.status(404).json({ ok: false });
  const has = await db.get('SELECT 1 x FROM wishlist WHERE user_id = ? AND product_id = ?', req.user.id, pid);
  if (has) await db.run('DELETE FROM wishlist WHERE user_id = ? AND product_id = ?', req.user.id, pid);
  else await db.run('INSERT INTO wishlist(user_id,product_id) VALUES(?,?)', req.user.id, pid);
  res.json({ ok: true, saved: !has });
});

module.exports = router;
