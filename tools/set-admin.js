// Sets the admin login email + password in whatever database .env points to:  npm run admin:set
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { db, init } = require('../src/db');
(async () => {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!email.includes('@') || pw.length < 8 || /CHANGE-ME/i.test(email + pw)) throw new Error('Set a real ADMIN_EMAIL and an ADMIN_PASSWORD of 8+ characters first.');
  await init();
  const admin = await db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const hash = bcrypt.hashSync(pw, 10);
  if (admin) await db.run('UPDATE users SET email = ?, password_hash = ? WHERE id = ?', email, hash, admin.id);
  else await db.run("INSERT INTO users(name,email,password_hash,role) VALUES('Store Admin',?,?,'admin')", email, hash);
  console.log('Admin login set for ' + email);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
