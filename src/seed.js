// Loads the 52 catalogue styles into an empty database and makes sure an admin account + sample coupon exist.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, init } = require('./db');

const DEFAULT_STOCK = Number(process.env.SEED_STOCK || 25);
let done = null;

async function run() {
  await init();
  const count = (await db.get('SELECT COUNT(*) c FROM products')).c;
  if (count === 0) {
    const file = path.join(__dirname, '..', 'data', 'catalog.json');
    if (fs.existsSync(file)) {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      // products first (need their ids), then images + variants in batches
      for (let i = 0; i < items.length; i++) {
        const p = items[i];
        const r = await db.run(`INSERT INTO products(code,slug,name,category,description,composition,extras,colors,sizes,price,mrp,active,featured,is_new,sort)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, p.code, p.slug, p.name, p.category, p.description, p.composition, JSON.stringify(p.extras),
          JSON.stringify(p.colors), JSON.stringify(p.sizes), p.price, p.mrp, i % 6 === 0 ? 1 : 0, i < 12 ? 1 : 0, i);
        const stmts = p.images.map((u, n) => ['INSERT INTO product_images(product_id,url,position) VALUES(?,?,?)', r.lastInsertRowid, u, n]);
        for (const c of p.colors) for (const s of p.sizes) stmts.push(['INSERT INTO variants(product_id,color,size,stock) VALUES(?,?,?,?)', r.lastInsertRowid, c.name, s, DEFAULT_STOCK]);
        await db.batch(stmts);
      }
      console.log(`[seed] loaded ${items.length} products`);
    } else console.warn('[seed] data/catalog.json not found. Run tools/build_catalog.py');
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@ojas.example').toLowerCase();
  if (!(await db.get('SELECT 1 x FROM users WHERE role = ?', 'admin'))) {
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    await db.run('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)', 'Store Admin', email, bcrypt.hashSync(pw, 10), 'admin');
    console.log(`[seed] admin created: ${email}`);
  }
  if (!(await db.get('SELECT 1 x FROM coupons'))) {
    await db.run("INSERT INTO coupons(code,type,value,min_order,active) VALUES('WELCOME10','percent',10,999,1)");
  }
}
// Once per server instance
const seed = () => (done ||= run().catch((e) => { done = null; throw e; }));
module.exports = { seed };

if (require.main === module) {
  require('dotenv').config();
  seed().then(() => { console.log('Database ready.'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
