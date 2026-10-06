const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'store.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
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
`);

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

const settingsCache = { v: null };
function getSettings() {
  if (settingsCache.v) return settingsCache.v;
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  settingsCache.v = s;
  return s;
}
function setSettings(obj) {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj)) if (k in DEFAULT_SETTINGS) up.run(k, String(v ?? ''));
  settingsCache.v = null;
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

module.exports = { db, tx, getSettings, setSettings, DEFAULT_SETTINGS };
