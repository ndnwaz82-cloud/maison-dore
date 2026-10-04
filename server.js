// Maison Doré — single-file bundle for deploy.
// Built from ~/workspace/maison-dore/store/ by build-deploy-bundle.js.
// Do NOT edit by hand; rebuild from source.
// Product images live in public/images/ (deployed alongside this file).
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookie = require('cookie');
const { Pool } = require('pg');

// ================= db.js =================
// PostgreSQL storage via the `pg` Pool (Render free tier provides DATABASE_URL).
// Maison Doré takes one-time purchases; Stripe collects the buyer's email,
// so no user accounts are needed. Orders are recorded from the webhook.
//
// getDb() keeps the same call shape as the old SQLite layer:
//   getDb().prepare('... ? ...').run(a, b)
// but run()/get()/all() return Promises (pg is async), so callers must await.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres requires TLS; PGSSL=disable allows local non-TLS use.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] idle pool error:', err.message);
});

let initPromise = null;
function ensureSchema() {
  if (!initPromise) {
    initPromise = pool
      .query(
        `CREATE TABLE IF NOT EXISTS orders (
           id SERIAL PRIMARY KEY,
           stripe_session_id TEXT UNIQUE NOT NULL,
           email TEXT,
           items_json TEXT NOT NULL,
           amount_total INTEGER NOT NULL,
           currency TEXT NOT NULL DEFAULT 'usd',
           shipping_json TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         );
         CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);`
      )
      .catch((err) => {
        initPromise = null; // allow retry on next use
        throw err;
      });
  }
  return initPromise;
}

// Convert SQLite-style ? placeholders to Postgres $1, $2, ...
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function getDb() {
  // Kick off schema creation (fire-and-forget at boot); log but don't crash
  // on failure — queries retry init on next use.
  ensureSchema().catch((err) =>
    console.error('[db] schema init failed (will retry on next use):', err.message)
  );
  return {
    prepare(sql) {
      const text = toPgPlaceholders(sql);
      const runQuery = (params) => ensureSchema().then(() => pool.query(text, params));
      return {
        run: (...params) => runQuery(params).then((r) => ({ changes: r.rowCount })),
        get: (...params) => runQuery(params).then((r) => r.rows[0]),
        all: (...params) => runQuery(params).then((r) => r.rows),
      };
    },
    // Raw escape hatch for future use.
    query: (text, params) => ensureSchema().then(() => pool.query(text, params)),
  };
}


// ================= products.js =================
// Maison Doré product catalog.
// ============================================================
// PRICES live here in one place — edit `priceCents` freely.
// Prices are in USD cents. Set by Lonnie 2026-10-04.
// ============================================================

const PRODUCTS = [
  {
    id: 'obsidian-sovereign',
    name: 'The Obsidian Sovereign',
    priceCents: 68500, // $685
    image: '/images/media-generation-obsidian-sovereign-0-982d9b29-9091-43ef-b3d2-9171a838bd9b.webp',
    materials: 'Black obsidian, turquoise inlay, gold bezel, sterling silver band',
    story: 'Our signature piece. A commanding oval of polished black obsidian — the stone Comanche ancestors shaped into blades sharper than steel — set in gold and ringed with turquoise, on a hand-stamped sterling silver band.',
  },
  {
    id: 'turquoise-mesa',
    name: 'Turquoise Mesa',
    priceCents: 54500, // $545
    image: '/images/media-generation-turquoise-mesa-0-f4b2d12b-4e77-48bd-9250-6cc55b97224f.webp',
    materials: 'Turquoise cabochon, gold rope border, obsidian inlay, sterling silver band',
    story: 'Sky-stone blue turquoise in a delicate gold rope frame, with black obsidian chip inlay tracing a brushed silver band. Understated, and unmistakably Southwestern.',
  },
  {
    id: 'desert-night-band',
    name: 'Desert Night Band',
    priceCents: 59500, // $595
    image: '/images/media-generation-desert-night-band-0-2840bd1d-6c7c-4516-95fa-882f41aed7f8.webp',
    materials: 'Black obsidian, turquoise, gold bezels, sterling silver band',
    story: 'Night over the plains: alternating obsidian and turquoise stones, each in its own gold bezel, channel-set across silver engraved with tribal line work.',
  },
  {
    id: 'golden-canyon',
    name: 'Golden Canyon',
    priceCents: 79500, // $795
    image: '/images/media-generation-golden-canyon-0-3fa39438-8fcf-4f23-a7c5-285e580a3535.webp',
    materials: 'Turquoise center, obsidian mosaic inlay, gold trim, sterling silver band',
    story: 'A bold rectangular turquoise center with obsidian mosaic radiating outward in gold trim — stamped with arrow and sun motifs on substantial silver. A true statement piece.',
  },
  {
    id: 'sovereign-all-gold',
    name: 'Sovereign in All Gold',
    priceCents: 215000, // $2150
    image: '/images/media-generation-sovereign-all-gold-0-9451ca81-0cbf-4bb4-af17-07c3b141fc5e.webp',
    materials: 'Black obsidian, turquoise inlay, solid gold throughout',
    story: 'The Obsidian Sovereign reimagined entirely in gold — obsidian and turquoise burning bright against an unbroken band of hand-stamped gold.',
  },
  {
    id: 'mesa-all-silver',
    name: 'Mesa in All Silver',
    priceCents: 42500, // $425
    image: '/images/media-generation-mesa-all-silver-0-cd4eadc0-6b9c-4639-a153-92a0080a75e3.webp',
    materials: 'Turquoise cabochon, obsidian inlay, sterling silver throughout',
    story: 'Turquoise Mesa in pure sterling silver — cool, clean, and quietly striking. Our most approachable piece, with nothing held back in craft.',
  },
  {
    id: 'obsidian-arrowhead',
    name: 'Obsidian Arrowhead',
    priceCents: 62500, // $625
    image: '/images/media-generation-obsidian-arrowhead-0-49fad4a4-bcf4-4e45-8a41-6a9d419009e1.webp',
    materials: 'Arrowhead-cut black obsidian, turquoise inlay, gold setting, sterling silver band',
    story: 'An arrowhead of polished obsidian — a nod to the first surgical blades, knapped by Native hands long before steel. Set in gold with turquoise dots and stamped feather motifs.',
  },
  {
    id: 'desert-night-all-gold',
    name: 'Desert Night in All Gold',
    priceCents: 189500, // $1895
    image: '/images/media-generation-desert-night-all-gold-0-1996a570-039a-44e3-ba4c-b2cccc9d5b70.webp',
    materials: 'Black obsidian, turquoise, solid gold band',
    story: 'The Desert Night band in solid gold — obsidian and turquoise set like constellations across warm, engraved gold. The crown of the collection.',
  },
];

const byId = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));

function formatPrice(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


// ================= views.js =================
// HTML views for Maison Doré. All copy is honest: no invented atelier
// address, staff, or history. Brand: Comanche-made luxury rings by Lonnie.
// NEVER mention "Obsidian" as a business name here (it is Lonnie's other
// business). "Obsidian" as a gemstone is fine and expected.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function layout({ title, body, extraHead = '' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Maison Doré</title>
<style>/* style.css (inlined for single-file deploy) */
/* Maison Doré — dark luxury, gold accents */
:root {
  --bg: #0e0d0b;
  --bg2: #161411;
  --gold: #d4af37;
  --gold-dim: #a8842c;
  --text: #f2ecdd;
  --muted: #9a917e;
  --line: #2a261f;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.6;
}
h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; line-height: 1.2; }
a { color: var(--gold); }
.site-header { border-bottom: 1px solid var(--line); background: var(--bg2); }
.site-header nav {
  max-width: 1100px; margin: 0 auto; padding: 1rem 1.25rem;
  display: flex; justify-content: space-between; align-items: center;
}
.brand { font-family: Georgia, serif; font-size: 1.5rem; color: var(--gold); text-decoration: none; letter-spacing: 0.04em; }
.nav-links a { color: var(--text); text-decoration: none; margin-left: 1.5rem; }
.nav-links a:hover { color: var(--gold); }
main { max-width: 1100px; margin: 0 auto; padding: 0 1.25rem 4rem; }
.site-footer { border-top: 1px solid var(--line); text-align: center; padding: 2rem 1rem; color: var(--muted); }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
.center { text-align: center; }
.error { color: #e08a8a; }
.eyebrow { text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.75rem; color: var(--gold); }
.hero { text-align: center; padding: 4rem 1rem 3rem; }
.hero h1 { font-size: 3.2rem; margin: 0.5rem 0; color: var(--gold); }
.lede { font-size: 1.2rem; max-width: 640px; margin: 1rem auto 2rem; }
.story { max-width: 680px; margin: 2rem auto 4rem; }
.story h2, .featured h2 { color: var(--gold); }
.btn {
  display: inline-block; padding: 0.85rem 2rem; border-radius: 2px;
  text-decoration: none; font-size: 1rem; cursor: pointer; border: 1px solid var(--gold);
}
.btn-gold { background: var(--gold); color: #141210; font-weight: 600; }
.btn-gold:hover { background: var(--gold-dim); }
.btn-ghost { background: transparent; color: var(--gold); }
.btn-ghost:hover { background: #1e1a14; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; overflow: hidden; text-decoration: none; color: var(--text); display: block; }
.card:hover { border-color: var(--gold-dim); }
.card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.card h3 { margin: 0.9rem 1rem 0.2rem; font-size: 1.05rem; }
.card .price { margin: 0.2rem 1rem 1rem; color: var(--gold); font-weight: 600; }
.card .muted { margin: 0 1rem; }
.page-head { padding: 2.5rem 0 1rem; }
.page-head h1 { color: var(--gold); margin-bottom: 0.3rem; }
.product { display: grid; grid-template-columns: 1fr 1fr; gap: 3rem; padding: 2.5rem 0; }
@media (max-width: 760px) { .product { grid-template-columns: 1fr; } }
.product-media img { width: 100%; border-radius: 4px; border: 1px solid var(--line); }
.product-info h1 { margin-top: 0.4rem; }
.price.big { font-size: 1.8rem; color: var(--gold); font-weight: 700; }
label { display: block; margin: 1rem 0; font-weight: 600; }
label input, label select {
  display: block; width: 100%; margin-top: 0.4rem; padding: 0.7rem;
  background: #1c1915; border: 1px solid var(--line); color: var(--text); border-radius: 3px;
}
form .btn { margin-top: 0.5rem; width: 100%; }
.cart-row { display: grid; grid-template-columns: 90px 1fr auto auto; gap: 1rem; align-items: center; padding: 1rem 0; border-bottom: 1px solid var(--line); }
.cart-row img { width: 90px; height: 90px; object-fit: cover; border-radius: 4px; }
.cart-row h3 { margin: 0; font-size: 1rem; }
.linklike { background: none; border: none; color: var(--muted); cursor: pointer; text-decoration: underline; font-size: 0.85rem; padding: 0; width: auto; margin: 0; }
.cart-total { text-align: right; font-size: 1.3rem; margin: 1.5rem 0; }
</style>${extraHead}</head>
<body>
<header class="site-header"><nav>
<a class="brand" href="/">Maison Doré</a>
<span class="nav-links"><a href="/shop">Shop</a><a href="/cart">Cart</a></span>
</nav></header>
<main>${body}</main>
<footer class="site-footer">
<p>Maison Doré — Comanche-made luxury rings, shipped worldwide.</p>
<p class="muted small">Each ring is crafted to order. International buyers are responsible for any customs duties.</p>
</footer>
</body></html>`;
}

function homePage() {
  const featured = ['obsidian-sovereign', 'golden-canyon', 'obsidian-arrowhead', 'desert-night-all-gold']
    .map((id) => byId[id]);
  const cards = featured.map((p) => `
    <a class="card" href="/product/${p.id}">
      <img src="${p.image}" alt="${esc(p.name)}" loading="lazy">
      <h3>${esc(p.name)}</h3>
      <p class="price">${formatPrice(p.priceCents)}</p>
    </a>`).join('');
  return layout({
    title: 'Comanche-made luxury rings',
    body: `
<section class="hero">
  <p class="eyebrow">Comanche-made · Ships worldwide</p>
  <h1>Maison Doré</h1>
  <p class="lede">Luxury rings designed and hand-crafted by Lonnie, a Comanche artist — black obsidian, turquoise, sterling silver, and gold, in original Native American-inspired designs.</p>
  <p><a class="btn btn-gold" href="/shop">Shop the collection</a></p>
</section>
<section class="story">
  <h2>The house</h2>
  <p>Maison Doré is owned and operated by a Native American artist. Every ring begins as an original design and is crafted to order — obsidian once knapped into blades sharper than steel, turquoise the color of desert sky, worked in silver and gold.</p>
  <p>We sell to collectors everywhere. If you are outside the United States, you are welcome here — we ship worldwide.</p>
</section>
<section class="featured">
  <h2>Featured pieces</h2>
  <div class="grid">${cards}</div>
  <p class="center"><a class="btn btn-ghost" href="/shop">View all eight pieces</a></p>
</section>`,
  });
}

function shopPage() {
  const cards = PRODUCTS.map((p) => `
    <a class="card" href="/product/${p.id}">
      <img src="${p.image}" alt="${esc(p.name)}" loading="lazy">
      <h3>${esc(p.name)}</h3>
      <p class="muted small">${esc(p.materials)}</p>
      <p class="price">${formatPrice(p.priceCents)}</p>
    </a>`).join('');
  return layout({
    title: 'Shop all rings',
    body: `
<section class="page-head">
  <h1>The collection</h1>
  <p class="muted">Eight original designs. Each ring is crafted to order in your size.</p>
</section>
<div class="grid">${cards}</div>`,
  });
}

const SIZES = [];
for (let s = 5; s <= 13; s += 0.5) SIZES.push(s);

function productPage(p, note) {
  const sizes = SIZES.map((s) => `<option value="${s}">${s}</option>`).join('');
  return layout({
    title: p.name,
    body: `
<section class="product">
  <div class="product-media"><img src="${p.image}" alt="${esc(p.name)}"></div>
  <div class="product-info">
    <p class="eyebrow">Comanche-made · Made to order</p>
    <h1>${esc(p.name)}</h1>
    <p class="price big">${formatPrice(p.priceCents)}</p>
    <p>${esc(p.story)}</p>
    <p class="muted small"><strong>Materials:</strong> ${esc(p.materials)}</p>
    <p class="muted small">Each ring is crafted to order after purchase — please allow several weeks for your piece to be made and shipped. We ship worldwide.</p>
    ${note ? `<p class="error">${esc(note)}</p>` : ''}
    <form method="POST" action="/cart/add">
      <input type="hidden" name="id" value="${esc(p.id)}">
      <label>Ring size
        <select name="size" required>${sizes}</select>
      </label>
      <button type="submit" class="btn btn-gold">Add to cart — ${formatPrice(p.priceCents)}</button>
    </form>
    <p><a class="muted small" href="/shop">&larr; Back to the collection</a></p>
  </div>
</section>`,
  });
}

function cartPage(items) {
  if (!items.length) {
    return layout({
      title: 'Your cart',
      body: `<section class="page-head"><h1>Your cart</h1><p class="muted">Your cart is empty.</p>
      <p><a class="btn btn-gold" href="/shop">Browse the collection</a></p></section>`,
    });
  }
  const rows = items.map((it, i) => `
    <div class="cart-row">
      <img src="${it.product.image}" alt="${esc(it.product.name)}">
      <div><h3>${esc(it.product.name)}</h3>
      <p class="muted small">Size ${esc(it.size)} &times; ${it.qty}</p></div>
      <p class="price">${formatPrice(it.product.priceCents * it.qty)}</p>
      <form method="POST" action="/cart/remove"><input type="hidden" name="index" value="${i}">
      <button class="linklike" type="submit">Remove</button></form>
    </div>`).join('');
  const total = items.reduce((t, it) => t + it.product.priceCents * it.qty, 0);
  return layout({
    title: 'Your cart',
    body: `<section class="page-head"><h1>Your cart</h1></section>
    <div class="cart">${rows}</div>
    <p class="cart-total">Total <strong>${formatPrice(total)}</strong></p>
    <form method="POST" action="/checkout"><button class="btn btn-gold" type="submit">Checkout securely</button></form>
    <p class="muted small">Secure payment via Stripe. We ship worldwide; international buyers are responsible for customs duties.</p>`,
  });
}

function simplePage(title, heading, sub, bodyHtml) {
  return layout({
    title,
    body: `<section class="page-head"><h1>${esc(heading)}</h1>
    <p class="muted">${sub}</p>${bodyHtml || ''}</section>`,
  });
}


// ================= routes/shop.js =================
// Shop routes: home, shop grid, product detail, session cart.
// Cart lives in a plain JSON cookie; prices are ALWAYS taken from the
// server-side PRODUCTS config at checkout, so cookie tampering cannot
// change what anyone is charged.

const shopRouter = express.Router();
shopRouter.use(express.urlencoded({ extended: false }));

function readCart(req) {
  try {
    const raw = cookie.parse(req.headers.cookie || '').md_cart;
    if (!raw) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    // Validate: known product ids, sane sizes and quantities.
    return items
      .filter((it) => it && byId[it.id] && Number.isFinite(Number(it.size)) && Number(it.size) >= 4 && Number(it.size) <= 15)
      .map((it) => ({
        product: byId[it.id],
        size: String(it.size),
        qty: Math.min(9, Math.max(1, parseInt(it.qty, 10) || 1)),
      }));
  } catch { return []; }
}

function writeCart(res, items) {
  res.setHeader('Set-Cookie', cookie.serialize('md_cart', JSON.stringify(
    items.map((it) => ({ id: it.product.id, size: it.size, qty: it.qty }))
  ), { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 }));
}

shopRouter.get('/', (req, res) => res.send(homePage()));
shopRouter.get('/shop', (req, res) => res.send(shopPage()));

shopRouter.get('/product/:id', (req, res) => {
  const p = byId[req.params.id];
  if (!p) return res.status(404).send('Not found');
  res.send(productPage(p, null));
});

shopRouter.get('/cart', (req, res) => res.send(cartPage(readCart(req))));

shopRouter.post('/cart/add', (req, res) => {
  const p = byId[String(req.body.id || '')];
  const size = String(req.body.size || '');
  if (!p || !/^\d+(\.5)?$/.test(size) || Number(size) < 4 || Number(size) > 15) {
    return res.status(400).send(productPage(p || Object.values(byId)[0], 'Please choose a valid ring size.'));
  }
  const items = readCart(req);
  const existing = items.find((it) => it.product.id === p.id && it.size === size);
  if (existing) existing.qty = Math.min(9, existing.qty + 1);
  else items.push({ product: p, size, qty: 1 });
  writeCart(res, items);
  res.redirect('/cart');
});

shopRouter.post('/cart/remove', (req, res) => {
  const items = readCart(req);
  const i = parseInt(req.body.index, 10);
  if (Number.isInteger(i) && i >= 0 && i < items.length) items.splice(i, 1);
  writeCart(res, items);
  res.redirect('/cart');
});

// ================= routes/checkout.js =================
// Stripe checkout for Maison Doré.
// Mounted at / by src/server.js AFTER the shop router — but the webhook
// route is registered FIRST in this file with express.raw() so the Stripe
// signature check sees the raw body.

const checkoutRouter = express.Router();

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const isPlaceholder = (v) => !v || String(v).includes('PASTE_YOUR');
const stripeConfigured = () => !isPlaceholder(process.env.STRIPE_SECRET_KEY);
const webhookConfigured = () => !isPlaceholder(process.env.STRIPE_WEBHOOK_SECRET);

function stripeClient() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Broad country list so international buyers can check out with a
// shipping address. (Sanctioned regions excluded.)
const ALLOWED_COUNTRIES = [
  'US','CA','MX','GB','IE','FR','DE','ES','IT','PT','NL','BE','LU','CH','AT',
  'SE','NO','DK','FI','IS','GR','PL','CZ','SK','HU','RO','BG','HR','SI','EE',
  'LV','LT','MT','CY','AU','NZ','JP','KR','SG','HK','TW','TH','MY','PH','ID',
  'VN','IN','AE','SA','QA','KW','BH','OM','IL','TR','ZA','NG','KE','GH','EG',
  'MA','BR','AR','CL','CO','PE','UY','EC','CR','PA','DO','JM','BS','BB','TT',
  'MU','SC','FJ','PG','LK','BD','NP','MN','KZ','GE','AM','AZ','UA','MD','RS',
  'BA','MK','AL','LI','MC','AD','SM','VA',
];

// ---------------------------------------------------------------- webhook
// FIRST route: raw body required for signature verification.
checkoutRouter.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeConfigured() || !webhookConfigured()) {
    return res.status(400).send('webhook not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email || null;
    try {
      await getDb().prepare(
        `INSERT INTO orders
         (stripe_session_id, email, items_json, amount_total, currency, shipping_json)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (stripe_session_id) DO NOTHING`
      ).run(
        session.id,
        email,
        session.metadata?.items || '[]',
        session.amount_total || 0,
        session.currency || 'usd',
        JSON.stringify(session.customer_details || {})
      );
    } catch (dbErr) {
      return res.status(500).send('webhook processing error');
    }
  }
  return res.status(200).send('ok');
});

// Body parsers for everything below (AFTER the raw webhook route).
checkoutRouter.use(express.urlencoded({ extended: false }));
checkoutRouter.use(express.json());

// ---------------------------------------------------------------- checkout
checkoutRouter.post('/checkout', async (req, res) => {
  const items = readCart(req);
  if (!items.length) return res.redirect('/cart');
  if (!stripeConfigured()) {
    return res.send(simplePage(
      'Checkout — Maison Doré',
      "Payments aren't connected yet",
      'The store owner still needs to connect Stripe before this page can take payment. Please check back shortly.',
      '<p><a class="btn btn-ghost" href="/cart">Back to cart</a></p>'
    ));
  }
  try {
    const line_items = items.map((it) => ({
      price_data: {
        currency: 'usd',
        unit_amount: it.product.priceCents,
        product_data: {
          name: `${it.product.name} — size ${it.size}`,
          description: it.product.materials,
          images: [`${APP_URL}${it.product.image}`],
        },
      },
      quantity: it.qty,
    }));
    const session = await stripeClient().checkout.sessions.create({
      mode: 'payment',
      line_items,
      metadata: {
        items: JSON.stringify(items.map((it) => ({ id: it.product.id, size: it.size, qty: it.qty }))),
      },
      shipping_address_collection: { allowed_countries: ALLOWED_COUNTRIES },
      phone_number_collection: { enabled: true },
      success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/cancel`,
    });
    writeCart(res, []); // cart converts to a Stripe session; clear it
    return res.redirect(303, session.url);
  } catch (err) {
    return res.status(500).send(simplePage(
      'Checkout — Maison Doré',
      'Checkout failed',
      'Something went wrong creating your payment session. Please try again in a moment.',
      '<p><a class="btn btn-ghost" href="/cart">Back to cart</a></p>'
    ));
  }
});

// ---------------------------------------------------------------- success
checkoutRouter.get('/success', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!sessionId || !stripeConfigured()) {
    return res.status(400).send(simplePage(
      'Order confirmed — Maison Doré',
      'Thank you — your order is confirmed',
      'Your payment went through. A confirmation was sent to your email. Each ring is crafted to order — please allow several weeks for your piece to be made and shipped.',
      '<p><a class="btn btn-ghost" href="/shop">Continue browsing</a></p>'
    ));
  }
  let session;
  try {
    session = await stripeClient().checkout.sessions.retrieve(sessionId);
  } catch (err) { session = null; }
  const paid = session && session.payment_status === 'paid';
  const total = session ? formatPrice(session.amount_total || 0) : '';
  const email = session ? (session.customer_details?.email || session.customer_email || '') : '';
  res.send(simplePage(
    'Order confirmed — Maison Doré',
    paid ? 'Thank you — your order is confirmed' : 'Thank you for your order',
    paid
      ? `Payment of ${total} received${email ? ` (${esc(email)})` : ''}. Each ring is crafted to order — please allow several weeks for your piece to be made and shipped worldwide.`
      : 'If your payment completed, a confirmation is on its way to your email.',
    '<p><a class="btn btn-ghost" href="/shop">Continue browsing</a></p>'
  ));
});

// ----------------------------------------------------------------- cancel
checkoutRouter.get('/cancel', (req, res) => {
  res.send(simplePage(
    'Checkout cancelled — Maison Doré',
    'Checkout cancelled',
    'No payment was taken. Your cart is waiting whenever you are ready.',
    '<p><a class="btn btn-gold" href="/cart">Back to cart</a></p><p><a class="muted small" href="/shop">Continue browsing</a></p>'
  ));
});

// ================= server.js =================
// Maison Doré — Comanche-made luxury rings, sold direct worldwide.
// Standalone Express + SQLite + Stripe Checkout. No user accounts:
// Stripe collects the buyer's email; orders are stored from the webhook.
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

getDb(); // create schema on boot
app.use(express.static(path.join(__dirname, 'public'))); // images live in public/images/

// Shop router first (/, /shop, /product/:id, /cart).
// Checkout router registers /billing/webhook with express.raw() BEFORE any
// JSON parser runs, so Stripe signature verification sees the raw body.
app.use('/', shopRouter);
app.use('/', checkoutRouter);

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => console.log(`Maison Doré listening on port ${PORT}`));
