// Database layer (libSQL = SQLite-compatible). Works with a local file in development and with a hosted
// Turso database on Vercel (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

const remote = !!process.env.TURSO_DATABASE_URL;
let url = process.env.TURSO_DATABASE_URL;
if (!url) {
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  url = 'file:' + file;
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const clean = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const toObj = (rs, r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]]));

function api(ex) {
  return {
    async all(sql, ...args) { const rs = await ex.execute({ sql, args: clean(args) }); return rs.rows.map((r) => toObj(rs, r)); },
    async get(sql, ...args) { const rs = await ex.execute({ sql, args: clean(args) }); return rs.rows[0] ? toObj(rs, rs.rows[0]) : undefined; },
    async run(sql, ...args) {
      const rs = await ex.execute({ sql, args: clean(args) });
      return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid || 0) };
    },
  };
}
const db = api(client);
db.batch = (stmts) => client.batch(stmts.map(([sql, ...args]) => ({ sql, args: clean(args) })), 'write');

// Runs fn(t) in a write transaction; t has the same get/all/run methods as db.
async function tx(fn) {
  const t = await client.transaction('write');
  try { const r = await fn(api(t)); await t.commit(); return r; }
  catch (e) { try { await t.rollback(); } catch {} throw e; }
  finally { t.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT, phone TEXT, line1 TEXT, line2 TEXT, city TEXT, state TEXT, pincode TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  category TEXT NOT NULL, description TEXT, composition TEXT, extras TEXT DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]', sizes TEXT NOT NULL DEFAULT '[]',
  price INTEGER NOT NULL, mrp INTEGER, active INTEGER DEFAULT 1, featured INTEGER DEFAULT 0,
  is_new INTEGER DEFAULT 0, sold INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL, position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS variants (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT NOT NULL, size TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, color, size)
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL, phone TEXT, name TEXT, ship TEXT NOT NULL,
  subtotal INTEGER, discount INTEGER DEFAULT 0, shipping INTEGER DEFAULT 0, cod_fee INTEGER DEFAULT 0, total INTEGER NOT NULL,
  coupon TEXT, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending', gateway_order_id TEXT, gateway_payment_id TEXT,
  carrier TEXT, tracking_no TEXT, note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, code TEXT, name TEXT, color TEXT, size TEXT, price INTEGER, qty INTEGER, image TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL, rating INTEGER NOT NULL,
  title TEXT, body TEXT, verified INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wishlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY COLLATE NOCASE, type TEXT NOT NULL, value INTEGER NOT NULL, min_order INTEGER DEFAULT 0,
  max_uses INTEGER DEFAULT 0, used INTEGER DEFAULT 0, expires_at TEXT, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, subject TEXT, body TEXT,
  status TEXT DEFAULT 'new', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY COLLATE NOCASE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status);
`;

let ready = null;
// Creates tables when the database is empty. Runs once per server instance.
function init() {
  if (!ready) {
    ready = (async () => {
      const has = await db.get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='sessions'");
      if (!has) { await client.executeMultiple('PRAGMA foreign_keys = ON;' + SCHEMA); }
      await loadSettings();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const DEFAULT_SETTINGS = {
  store_name: 'OJAS',
  tagline: 'Activewear for Women',
  email: 'support@ojas.example',
  phone: '+91 90000 00000',
  whatsapp: '919000000000',
  address: 'Your store address, City, State, PIN',
  hours: 'Mon-Sat, 10:00 AM - 7:00 PM',
  instagram: '',
  facebook: '',
  announcement: 'Free shipping on orders above {free_shipping_over}  |  Cash on Delivery available',
  shipping_fee: '79',
  free_shipping_over: '1999',
  cod_enabled: '1',
  cod_fee: '49',
  cod_max: '10000',
  return_days: '7',
  reviews_auto_approve: '0',
  low_stock: '5',
  size_chart: JSON.stringify([
    ['XS', '31-32', '24-25', '34-35'], ['S', '33-34', '26-27', '36-37'], ['M', '35-36', '28-29', '38-39'],
    ['L', '37-38', '30-31', '40-41'], ['XL', '39-41', '32-34', '42-44'], ['XXL', '42-44', '35-37', '45-47'],
    ['XXXL', '45-47', '38-40', '48-50'],
  ]),
};

// Settings are cached in memory for a few seconds (several server instances may run at once on Vercel).
const cache = { v: { ...DEFAULT_SETTINGS }, at: 0 };
const TTL = 10000;
async function loadSettings(force = false) {
  if (!force && Date.now() - cache.at < TTL) return cache.v;
  const rows = await db.all('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  cache.v = s; cache.at = Date.now();
  return s;
}
const getSettings = () => cache.v; // synchronous read of the latest loaded settings
async function setSettings(obj) {
  const stmts = Object.entries(obj).filter(([k]) => k in DEFAULT_SETTINGS)
    .map(([k, v]) => ['INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v ?? '')]);
  if (stmts.length) await db.batch(stmts);
  await loadSettings(true);
}

module.exports = { db, tx, init, getSettings, loadSettings, setSettings, DEFAULT_SETTINGS, remote };
