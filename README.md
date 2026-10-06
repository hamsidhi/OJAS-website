# OJAS Activewear: online store

A complete e-commerce website for **OJAS – Activewear for Women**, built from the 52-style supplier catalogue
(`1. Size zero combined styles.pdf`). Customers browse, pick colour/size, pay online or on delivery and track their
order. You manage everything from an admin panel.

## Run it

Requires **Node.js 22.13 or newer** (you have it). No database to install.

```bash
cd ojas-store
npm install
npm start
```

* Store:  http://localhost:3100
* Admin:  http://localhost:3100/admin  (sign in with the admin email/password from `.env`)

On first start the 52 products are loaded automatically. Default admin (change it!):
`admin@ojas.example` / `ChangeMe123!` (set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` **before** the first start,
or change the password later in *My account → Profile*).

Test everything with `npm start` running, then in another terminal: `node tools/smoke-test.js`

## What customers get

Home page · shop with filters (category, size, colour, price) and sorting · live search · product pages (photo gallery,
colour swatches, size availability, fabric composition, size guide, reviews) · wishlist · shopping bag with coupons and
free-shipping progress · guest or account checkout · UPI / cards / netbanking (Razorpay), international cards (Stripe),
Cash on Delivery · order confirmation emails · order tracking · accounts with order history and saved address ·
password reset · customer feedback page · contact form + WhatsApp chat button · About, FAQ, Shipping & Returns,
Size Guide, Privacy, Terms pages · mobile-friendly.

## What you get (Admin panel → `/admin`)

Dashboard with sales and setup checklist · **Products** (edit prices inline, stock for every colour × size, photos,
add/hide/delete) · **Orders** (status, courier + tracking number, customer email updates, cancel & restock, print invoice,
CSV export) · Customers + newsletter list · Reviews moderation · Contact-form inbox · Coupons · Settings (contact
details, shipping fee, free-shipping threshold, COD, size chart).

## Before you go live: checklist

1. **Prices and stock are placeholders.** The catalogue had no prices or quantities. Open *Admin → Products* and set
   real prices (edit inline) and stock. Starting stock is 25 for every colour/size.
2. **Product names are descriptive.** The catalogue only had style codes (e.g. `JYJN050`), so each style was given a
   name based on its photos. Rename in the product editor if you like.
3. **Contact details** (*Admin → Settings*): replace the placeholder email, phone, WhatsApp number and address.
4. **Colour names:** a few catalogue colours are labelled "White" but are actually pale blue; these are shown as
   "Pale Aqua Blue". "Dark Red" in the catalogue is used for different shades; some are named *Dusty Rose* / *Burgundy*.
5. **Size chart, shipping times, return policy and legal pages** are generic templates. Check them against how you
   actually operate (and with your accountant/lawyer for GST, returns and consumer-law wording).
6. Copy `.env.example` to `.env` and set: `SESSION_SECRET` (long random text), a new admin password, `BASE_URL`
   (your domain), `NODE_ENV=production`, `DEMO_PAYMENTS=false`.

## Payments

Put keys in `.env`, restart, and the options appear automatically at checkout.

| Method | Setup |
| --- | --- |
| **Razorpay** (UPI, cards, netbanking, wallets) | Create an account at razorpay.com → API keys → set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. Add webhook `https://YOURSITE/webhooks/razorpay` (events `payment.captured`, `order.paid`) with a secret → `RAZORPAY_WEBHOOK_SECRET`. |
| **Stripe** (international cards) | Set `STRIPE_SECRET_KEY`. Add webhook `https://YOURSITE/webhooks/stripe` (events `checkout.session.completed`, `checkout.session.expired`) → `STRIPE_WEBHOOK_SECRET`. Needs a Stripe account that supports INR. |
| **Cash on Delivery** | On by default. Fee and max order value in *Admin → Settings*. |
| **Demo** | A fake gateway for trying the flow without keys. Turn off with `DEMO_PAYMENTS=false`. |

Always start with the gateway's **test keys**, place a test order, and only then switch to live keys.
Payment amounts are always calculated on the server, and payment confirmations are cryptographically verified;
card/UPI details never touch your server. Refunds are issued from the Razorpay/Stripe dashboard.

## Email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (Gmail app password, Brevo, Zoho, SES, etc.) to send order
confirmations, shipping updates and password-reset emails. Without SMTP, emails are written to `data/outbox.log`.

## Hosting

Any host that runs Node.js works (a small VPS, Render, Railway, Fly.io…). Requirements: HTTPS, set the `.env` values
above, and keep these folders on **persistent storage**: `data/` (database) and `public/uploads/` (photos you upload).
Back up `data/store.db` regularly. Run behind your host's HTTPS proxy (`NODE_ENV=production` already trusts one proxy).

## Project layout

```
server.js            app setup, security, sessions, CSRF
src/routes/          shop, cart+checkout+payments, account, pages, admin, webhooks
src/lib/             catalogue queries, cart, orders, payments (Razorpay/Stripe), email
views/               pages (EJS);  views/admin = admin panel
public/              css, js, logo, product photos (public/products/<style-code>/1-3.jpg)
data/catalog.json    the 52 styles extracted from the PDF;  data/store.db = live database (created on first run)
tools/               build_catalog.py (re-extract from the PDF), smoke-test.js
```

To re-import the catalogue from scratch: delete `data/store.db*`, optionally re-run
`python tools/build_catalog.py "path/to/catalogue.pdf"` (needs `pymupdf`, `pillow`), and start the server.
