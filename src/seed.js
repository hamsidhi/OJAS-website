// Loads the 52 catalogue styles into the database (only when the products table is empty)
// and makes sure the admin account + a sample coupon exist.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, tx } = require('./db');

const DEFAULT_STOCK = Number(process.env.SEED_STOCK || 25);

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (count === 0) {
    const file = path.join(__dirname, '..', 'data', 'catalog.json');
    if (fs.existsSync(file)) {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      tx(() => {
        const ip = db.prepare(`INSERT INTO products(code,slug,name,category,description,composition,extras,colors,sizes,price,mrp,active,featured,is_new,sort)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`);
        const im = db.prepare('INSERT INTO product_images(product_id,url,position) VALUES(?,?,?)');
        const iv = db.prepare('INSERT INTO variants(product_id,color,size,stock) VALUES(?,?,?,?)');
        items.forEach((p, i) => {
          const r = ip.run(p.code, p.slug, p.name, p.category, p.description, p.composition, JSON.stringify(p.extras),
            JSON.stringify(p.colors), JSON.stringify(p.sizes), p.price, p.mrp, i % 6 === 0 ? 1 : 0, i < 12 ? 1 : 0, i);
          p.images.forEach((u, n) => im.run(r.lastInsertRowid, u, n));
          for (const c of p.colors) for (const s of p.sizes) iv.run(r.lastInsertRowid, c.name, s, DEFAULT_STOCK);
        });
      });
      console.log(`[seed] loaded ${items.length} products`);
    } else console.warn('[seed] data/catalog.json not found. Run tools/build_catalog.py');
  }

  const email = (process.env.ADMIN_EMAIL || 'admin@ojas.example').toLowerCase();
  if (!db.prepare('SELECT 1 FROM users WHERE role = ?').get('admin')) {
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)')
      .run('Store Admin', email, bcrypt.hashSync(pw, 10), 'admin');
    console.log(`[seed] admin created: ${email}`);
  }
  if (!db.prepare('SELECT 1 FROM coupons').get()) {
    db.prepare("INSERT INTO coupons(code,type,value,min_order,active) VALUES('WELCOME10','percent',10,999,1)").run();
  }
}
module.exports = { seed };
