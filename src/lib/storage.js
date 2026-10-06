// Product photo storage: Vercel Blob when BLOB_READ_WRITE_TOKEN is set (production), otherwise public/uploads (local development).
const path = require('path');
const fs = require('fs');
const { token } = require('./util');

const enabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const dir = path.join(__dirname, '..', '..', 'public', 'uploads');

async function save(file) {
  const name = `${Date.now()}-${token(4)}${path.extname(file.originalname).toLowerCase()}`;
  if (enabled()) {
    const { put } = require('@vercel/blob');
    const r = await put(`products/${name}`, file.buffer, { access: 'public', contentType: file.mimetype });
    return r.url;
  }
  if (process.env.VERCEL) throw new Error('Photo storage is not connected. Add a Vercel Blob store to the project (see README).');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return '/uploads/' + name;
}

function remove(url) {
  try {
    if (/^https:\/\//.test(url) && enabled()) require('@vercel/blob').del(url).catch(() => {});
    else if (url.startsWith('/uploads/')) fs.unlink(path.join(dir, path.basename(url)), () => {});
  } catch { /* best effort */ }
}

module.exports = { save, remove, enabled };
