const crypto = require('crypto');

const inr = new Intl.NumberFormat('en-IN');
const money = (n) => '₹' + inr.format(Math.round(Number(n) || 0));
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const token = (n = 32) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const jparse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s || '');
const isPhone = (s) => /^[+]?[0-9\s-]{8,15}$/.test(s || '');
const isPin = (s) => /^[1-9][0-9]{5}$/.test(s || '');
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\]*$/.test(n) ? n : '/');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman & Nicobar Islands',
  'Chandigarh', 'Dadra & Nagar Haveli and Daman & Diu', 'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];

const CATEGORIES = ['Sports Bras', 'Tops & Tees', 'Long Sleeves & Jackets', 'Leggings & Pants', 'Shorts', 'Skirts & Skorts'];
const catSlug = (c) => slugify(c);
const catFromSlug = (s) => CATEGORIES.find((c) => slugify(c) === s);

const ORDER_STATUS = { pending: 'Awaiting payment', processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
const PAY_STATUS = { pending: 'Pending', paid: 'Paid', cod: 'Pay on delivery', failed: 'Failed', refunded: 'Refunded' };
const PAY_METHOD = { cod: 'Cash on Delivery', razorpay: 'Razorpay (UPI / Cards / Netbanking)', stripe: 'Card (Stripe)', demo: 'Demo payment' };

module.exports = { money, slugify, token, sha256, jparse, int, str, isEmail, isPhone, isPin, safeNext, esc, STATES, CATEGORIES, catSlug, catFromSlug,
  ORDER_STATUS, PAY_STATUS, PAY_METHOD };
