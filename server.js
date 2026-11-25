const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { handleHostedRequest } = require('./hosted-api');

const PORT = Number(process.env.PORT || 4317);
const TRACK_INTERVAL_MS = Number(process.env.TRACK_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6 hours default
const MAX_BODY = 3 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'shelf-db.json');
const USERS_DIR = path.join(DATA_DIR, 'users');
const AUTH_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_COOKIE = 'oneshelf_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const authAttempts = new Map();

const CATEGORY_VALUES = new Set(['fashion', 'wearables', 'tech', 'home', 'beauty', 'accessories', 'other']);
const CLOTHING_TYPES = {
  topwear: ['shirt', 't-shirt', 'polo', 'top', 'hoodie', 'sweatshirt', 'sweater', 'jacket'],
  bottomwear: ['jeans', 'trousers', 'track-pants', 'joggers', 'shorts', 'skirt', 'leggings'],
  'one-piece': ['dress', 'jumpsuit'],
  footwear: ['sneakers', 'shoes', 'sandals', 'slippers', 'boots'],
  underwear: ['underwear', 'boxers', 'trunks', 'briefs'],
  other: ['other']
};
const clothingTypeToDepartment = new Map(
  Object.entries(CLOTHING_TYPES).flatMap(([department, types]) => types.map(type => [type, department]))
);

const SEED_PRODUCTS = [
  {
    id: 'seed-amazon',
    name: 'Amazon product · ASIN B0DJFG537F',
    brand: 'Amazon India',
    url: 'https://www.amazon.in/dp/B0DJFG537F/',
    category: 'tech',
    price: null,
    targetPrice: null,
    notes: 'Open the listing or click "Check price" / configure KEEPA_API_KEY or RAINFOREST_API_KEY for automated Amazon tracking.',
    image: '',
    tags: ['ASIN B0DJFG537F', 'Amazon.in'],
    added: 4,
    saved: false,
    priceHistory: []
  },
  {
    id: 'seed-myntra',
    name: 'HIGHLANDER Graphic Printed Relaxed-Fit Shirt',
    brand: 'Myntra',
    url: 'https://www.myntra.com/shirts/highlander/highlander-graphic-printed-spread-collar-relaxed-fit-cotton-casual-shirt/37279916/buy?shared=true',
    category: 'fashion',
    price: null,
    targetPrice: 699,
    notes: 'Graphic-printed casual shirt with spread collar and relaxed fit.',
    image: '',
    tags: ['Graphic print', 'Spread collar', 'Relaxed fit'],
    added: 3,
    saved: false,
    priceHistory: []
  },
  {
    id: 'seed-xyxx',
    name: 'XYXX Full Sleeve Polo — Merlot Maroon',
    brand: 'XYXX',
    url: 'https://xyxxcrew.com/products/mens-full-sleeve-polo-tshirt-merlot-maroon',
    category: 'fashion',
    price: 1349,
    targetPrice: 1099,
    notes: 'Full-sleeve polo in merlot maroon. Supports direct Shopify JSON price tracking.',
    image: 'https://xyxxcrew.com/cdn/shop/files/FullSleevePolo-MerlotMaroon_1.jpg?width=900',
    tags: ['Merlot maroon', 'Full sleeve', 'Polo'],
    added: 2,
    saved: false,
    priceHistory: [
      { price: 1499, recordedAt: '2026-10-15T10:00:00.000Z', method: 'seed' },
      { price: 1399, recordedAt: '2026-10-28T10:00:00.000Z', method: 'seed' },
      { price: 1349, recordedAt: '2026-11-10T10:00:00.000Z', method: 'seed' }
    ]
  },
  {
    id: 'seed-noise',
    name: 'Noise REP 24×7 Fitness Tracker',
    brand: 'Flipkart',
    url: 'https://www.flipkart.com/noise-rep-24x7-fitness-tracker-no-subscription-hrv-4-stage-sleep-tracking-ai-insights/p/itm3cb03bf5c8e34?pid=SBNHP7ASCHGZUAJJ',
    category: 'wearables',
    price: 9999,
    targetPrice: 8499,
    notes: 'Fitness tracker with HRV, four-stage sleep tracking, and AI insights.',
    image: '',
    tags: ['HRV', 'Sleep tracking', 'No subscription'],
    added: 1,
    saved: false,
    priceHistory: [
      { price: 10999, recordedAt: '2026-10-20T10:00:00.000Z', method: 'seed' },
      { price: 9999, recordedAt: '2026-11-05T10:00:00.000Z', method: 'seed' }
    ]
  }
];

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ products: SEED_PRODUCTS, lastTrackRun: null }, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(raw.products)) raw.products = SEED_PRODUCTS;
    return raw;
  } catch {
    return { products: SEED_PRODUCTS, lastTrackRun: null };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function readAccounts() {
  if (!fs.existsSync(AUTH_FILE)) return { users: [] };
  const store = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (!Array.isArray(store.users)) throw Error('Account storage is invalid. Back up data/accounts.json before repairing it.');
  return store;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function userDbPath(userId) {
  if (!/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(userId)) throw Error('Invalid local account identifier.');
  return path.join(USERS_DIR, `${userId}.json`);
}

function readUserDb(userId) {
  const file = userDbPath(userId);
  if (!fs.existsSync(file)) return { products: [], lastTrackRun: null };
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(db.products)) throw Error('This account’s shelf data is invalid. Back up its data file before repairing it.');
  return { ...db, products: db.products.map(normalizeProduct) };
}

function writeUserDb(userId, db) {
  writeJson(userDbPath(userId), db);
}

function inferClothingType(product) {
  if (product.category !== 'fashion') return { department: '', clothingType: '' };
  const text = `${product.url || ''} ${product.name || ''} ${product.notes || ''}`.toLowerCase();
  const rules = [
    ['bottomwear', 'track-pants', /\btrack[\s-]?pants?\b|\btracksuit\b/],
    ['underwear', 'boxers', /\bboxers?\b/],
    ['underwear', 'trunks', /\btrunks?\b/],
    ['underwear', 'briefs', /\bbriefs?\b|\bunderwear\b|\binnerwear\b/],
    ['bottomwear', 'joggers', /\bjoggers?\b/],
    ['bottomwear', 'jeans', /\bjeans?\b|\bdenim\b/],
    ['bottomwear', 'trousers', /\btrousers?\b|\bpants?\b/],
    ['bottomwear', 'leggings', /\bleggings?\b/],
    ['bottomwear', 'shorts', /\bshorts?\b/],
    ['bottomwear', 'skirt', /\bskirts?\b/],
    ['one-piece', 'jumpsuit', /\bjumpsuits?\b|\brompers?\b/],
    ['one-piece', 'dress', /\bdresses?\b|\bgowns?\b/],
    ['footwear', 'sneakers', /\bsneakers?\b|\btrainers?\b/],
    ['footwear', 'boots', /\bboots?\b/],
    ['footwear', 'slippers', /\bslippers?\b|\bflip[\s-]?flops?\b|\bflips?\b/],
    ['footwear', 'sandals', /\bsandals?\b/],
    ['footwear', 'shoes', /\bshoes?\b|\bfootwear\b/],
    ['topwear', 't-shirt', /\bt[\s-]?shirts?\b|\btees?\b/],
    ['topwear', 'polo', /\bpolos?\b/],
    ['topwear', 'shirt', /\bshirts?\b/],
    ['topwear', 'hoodie', /\bhoodies?\b/],
    ['topwear', 'sweatshirt', /\bsweatshirts?\b/],
    ['topwear', 'sweater', /\bsweaters?\b|\bcardigans?\b/],
    ['topwear', 'jacket', /\bjackets?\b|\bcoats?\b/],
    ['topwear', 'top', /\btops?\b/]
  ];
  const match = rules.find(([, , pattern]) => pattern.test(text));
  return match ? { department: match[0], clothingType: match[1] } : { department: 'other', clothingType: 'other' };
}

function normalizeProduct(product) {
  const inferred = inferClothingType(product);
  const department = CLOTHING_TYPES[product.department]?.includes(product.clothingType)
    ? product.department
    : inferred.department;
  const clothingType = CLOTHING_TYPES[department]?.includes(product.clothingType)
    ? product.clothingType
    : inferred.clothingType;
  return { ...product, department, clothingType };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalProductUrl(raw) {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'eabUserId', 'eab_tests', 'campaign_id', 'ad_id', '_refId', '_appId', 'sourceid', 'client', 'ie'].includes(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function readCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function authenticatedUser(req) {
  const token = readCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = readAccounts().users.find(account => account.id === session.userId);
  if (!user) {
    sessions.delete(token);
    return null;
  }
  return { id: user.id, email: user.email };
}

function checkAuthRateLimit(req, res) {
  const address = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = authAttempts.get(address);
  if (current && current.resetAt > now && current.count >= AUTH_MAX_ATTEMPTS) {
    send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    return true;
  }
  const entry = current && current.resetAt > now ? current : { count: 0, resetAt: now + AUTH_WINDOW_MS };
  entry.count++;
  authAttempts.set(address, entry);
  return false;
}

function clearAuthRateLimit(req) {
  authAttempts.delete(req.socket.remoteAddress || 'unknown');
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireSameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function computeStats(p) {
  p = normalizeProduct(p);
  const history = Array.isArray(p.priceHistory) ? [...p.priceHistory].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)) : [];
  const prices = history.map(h => Number(h.price)).filter(n => Number.isFinite(n) && n > 0);
  if (p.price != null && Number.isFinite(Number(p.price)) && Number(p.price) > 0 && !prices.length) {
    prices.push(Number(p.price));
  }
  const currentPrice = p.price != null && Number.isFinite(Number(p.price)) ? Number(p.price) : (prices.length ? prices[prices.length - 1] : null);
  const lowestPrice = prices.length ? Math.min(...prices) : null;
  const highestPrice = prices.length ? Math.max(...prices) : null;
  const averagePrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const previousPrice = prices.length >= 2 ? prices[prices.length - 2] : null;
  const priceChange = currentPrice != null && previousPrice != null ? currentPrice - previousPrice : null;
  const priceChangePct = priceChange != null && previousPrice > 0 ? Number(((priceChange / previousPrice) * 100).toFixed(1)) : null;
  const isAtLowest = currentPrice != null && lowestPrice != null && prices.length > 1 && currentPrice <= lowestPrice;
  const belowTarget = currentPrice != null && p.targetPrice != null && Number(p.targetPrice) > 0 && currentPrice <= Number(p.targetPrice);
  return {
    ...p,
    priceHistory: history,
    stats: {
      currentPrice,
      lowestPrice,
      highestPrice,
      averagePrice,
      previousPrice,
      priceChange,
      priceChangePct,
      isAtLowest,
      belowTarget,
      snapshots: history.length
    }
  };
}

function send(res, status, data, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const a = ip.split('.').map(Number);
    return (
      a[0] === 10 || a[0] === 127 || a[0] === 0 ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      a[0] >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.');
  }
  return true;
}

async function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Error('Enter a valid product URL.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw Error('Only public HTTP/HTTPS URLs without embedded credentials are supported.');
  }
  if (u.port && !['80', '443'].includes(u.port)) {
    throw Error('Custom ports are not supported.');
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || (net.isIP(h) && privateIP(h))) {
    throw Error('Private/local addresses are not allowed.');
  }
  let ips;
  try {
    ips = await dns.lookup(h, { all: true });
  } catch {
    throw Error('The product host could not be resolved.');
  }
  if (!ips.length || ips.some(x => privateIP(x.address))) {
    throw Error('This host resolves to a private or restricted address.');
  }
  return u;
}

const decode = s => String(s || '')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/gi, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

const clean = s => decode(String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 1200);

function meta(h, keys) {
  for (const k of keys) {
    const e = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const r of [
      new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${e}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
      new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${e}["'][^>]*>`, 'i')
    ]) {
      const m = h.match(r);
      if (m) return clean(m[1]);
    }
  }
  return '';
}

function productLd(h) {
  for (const m of h.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack = [JSON.parse(m[1].trim())];
      while (stack.length) {
        const o = stack.shift();
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o)) { stack.push(...o); continue; }
        if (o['@graph']) stack.push(...o['@graph']);
        if ([].concat(o['@type'] || []).some(t => /Product/i.test(t))) {
          const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
          let image = Array.isArray(o.image) ? o.image[0] : o.image;
          if (image && typeof image === 'object') image = image.url || image.contentUrl;
          return {
            title: clean(o.name),
            description: clean(o.description),
            image: typeof image === 'string' ? image : '',
            price: offer?.price ?? offer?.lowPrice ?? offer?.highPrice ?? null,
            brand: clean(typeof o.brand === 'string' ? o.brand : o.brand?.name)
          };
        }
      }
    } catch {}
  }
  return {};
}

function extractStoreFallbackPrice(html, url) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (host.includes('amazon')) {
    const m = html.match(/class=["']a-price-whole["'][^>]*>([\d,]+)/i) ||
              html.match(/"priceAmount"\s*:\s*([\d.]+)/i) ||
              html.match(/id=["']priceblock_ourprice["'][^>]*>[^0-9]*([\d,]+(?:\.\d+)?)/i);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  if (host.includes('flipkart')) {
    const m = html.match(/"finalPrice"\s*:\s*\{[^}]*"value"\s*:\s*(\d+)/i) ||
              html.match(/class=["']Nx9bqj[^"']*["'][^>]*>₹\s*([\d,]+)/i);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  if (host.includes('myntra')) {
    const m = html.match(/"discounted"\s*:\s*(\d+)/i) || html.match(/"mrp"\s*:\s*(\d+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function categoryFrom(url, title, desc) {
  const s = (url + ' ' + title + ' ' + desc).toLowerCase();
  if (/fitness tracker|smartwatch|sleep tracking|hrv|wearable|smart band|\bwatch\b|g-shock|gshock/.test(s)) return 'wearables';
  if (/laptop|phone|mobile|headphone|earbud|earphone|audio|power[\s-]?bank|camera|keyboard|monitor|electronics|kz-/.test(s)) return 'tech';
  if (/slipper|\bflips?\b|\bflip[\s-]?flops?\b|sandal|sneaker|footwear|\bshoes?\b|boots?/.test(s)) return 'fashion';
  if (/shirt|t-?shirt|polo|jeans|trousers|track[\s-]?pants|joggers|shorts|leggings|boxers?|trunks?|briefs?|underwear|hoodie|sweater|jacket|dress|clothing|apparel|fashion|kurta|saree/.test(s)) return 'fashion';
  if (/backpacks?|handbags?|tote bags?|duffel bags?|wallets?|sunglasses|eyewear|belts?|caps?|beanies?|scarves|jewel[lr]y|bracelets?|necklaces?|earrings?|accessories/.test(s)) return 'accessories';
  if (/sofa|lamp|furniture|bedsheet|kitchen|home decor|yoga[\s-]?mat|tumbler/.test(s)) return 'home';
  if (/skincare|beauty|cosmetic|shampoo|perfume|makeup/.test(s)) return 'beauty';
  return 'other';
}

function withClothingType(data) {
  const clothing = inferClothingType({
    category: data.category,
    url: data.finalUrl,
    name: data.title,
    notes: data.description
  });
  return { ...data, ...clothing };
}

function extractAsin(url) {
  const m = String(url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

// Optional Shopify JSON fast-path (works for D2C brands like XYXX, Boat, Snitch, etc.)
async function tryShopifyJson(rawUrl) {
  try {
    const u = await validateUrl(rawUrl);
    if (!u.pathname.includes('/products/')) return null;
    const handle = u.pathname.split('/products/')[1].split('/')[0];
    if (!handle) return null;
    const jsonUrl = `${u.origin}/products/${handle}.json`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    const r = await fetch(jsonUrl, { signal: ctl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'ONE-SHELF-Tracker/1.0' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();
    const prod = data?.product;
    if (!prod) return null;
    const variant = prod.variants?.[0];
    const price = variant?.price ? Number(variant.price) : null;
    const image = prod.image?.src || prod.images?.[0]?.src || '';
    const title = clean(prod.title);
    const description = clean(prod.body_html);
    return withClothingType({
      title,
      description,
      image,
      price: Number.isFinite(price) ? price : null,
      brand: clean(prod.vendor),
      category: categoryFrom(rawUrl, title, description),
      finalUrl: rawUrl,
      method: 'shopify-json',
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return null;
  }
}

// Optional Keepa API adapter for Amazon.in (domain=10) when KEEPA_API_KEY is configured
async function tryKeepaAdapter(rawUrl) {
  const key = process.env.KEEPA_API_KEY;
  if (!key) return null;
  const asin = extractAsin(rawUrl);
  if (!asin) return null;
  const domainId = rawUrl.includes('amazon.in') ? 10 : 1; // 10 = Amazon India
  const apiUrl = `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=${domainId}&asin=${asin}&stats=180`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(apiUrl, { signal: ctl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const p = data?.products?.[0];
    if (!p) return null;
    const currentRaw = p.stats?.current?.[0] ?? p.stats?.current?.[1] ?? -1;
    const price = currentRaw > 0 ? Math.round(currentRaw / 100) : null;
    const imgName = p.imagesCSV ? p.imagesCSV.split(',')[0] : '';
    const image = imgName ? `https://images-na.ssl-images-amazon.com/images/I/${imgName}` : '';
    const csv = p.csv?.[0] || p.csv?.[1] || [];
    const history = [];
    for (let i = 0; i < csv.length - 1; i += 2) {
      const keepaMin = csv[i], val = csv[i + 1];
      if (val > 0) {
        const ms = (keepaMin + 21564000) * 60000;
        history.push({ price: Math.round(val / 100), recordedAt: new Date(ms).toISOString(), method: 'keepa-api' });
      }
    }
    return withClothingType({
      title: clean(p.title),
      description: clean((p.features || []).slice(0, 3).join(' · ')),
      image,
      price,
      brand: clean(p.brand || 'Amazon'),
      category: categoryFrom(rawUrl, p.title || '', ''),
      finalUrl: rawUrl,
      history: history.slice(-60),
      method: 'keepa-api',
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Optional Rainforest API adapter for Amazon when RAINFOREST_API_KEY is configured
async function tryRainforestAdapter(rawUrl) {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) return null;
  const asin = extractAsin(rawUrl);
  if (!asin) return null;
  const amazonDomain = (() => { try { return new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { return 'amazon.in'; } })();
  const apiUrl = `https://api.rainforestapi.com/request?api_key=${encodeURIComponent(key)}&type=product&amazon_domain=${encodeURIComponent(amazonDomain)}&asin=${asin}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(apiUrl, { signal: ctl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const p = data?.product;
    if (!p) return null;
    const price = p.buybox_winner?.price?.value ?? null;
    return withClothingType({
      title: clean(p.title),
      description: clean(p.feature_bullets?.slice(0, 3).join(' · ') || ''),
      image: p.main_image?.link || '',
      price: Number.isFinite(Number(price)) ? Number(price) : null,
      brand: clean(p.brand || 'Amazon'),
      category: categoryFrom(rawUrl, p.title || '', ''),
      finalUrl: rawUrl,
      method: 'rainforest-api',
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchPublicHtml(raw) {
  let u = await validateUrl(raw);
  for (let i = 0; i < 4; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(u, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ONE-SHELF-Tracker/1.0)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-IN,en;q=0.9'
        }
      });
    } catch (e) {
      throw Error(e.name === 'AbortError' ? 'The store took too long to respond.' : 'Store unreachable; it may block automated requests.');
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) throw Error('Invalid redirect from store.');
      u = await validateUrl(new URL(loc, u).toString());
      continue;
    }
    if (!r.ok) throw Error(`Store returned HTTP ${r.status}; it may require a session or block automated access.`);
    if (!/text\/html|application\/xhtml\+xml/i.test(r.headers.get('content-type') || '')) {
      throw Error('URL did not return an HTML product page.');
    }
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > 2e6) {
        await reader.cancel();
        throw Error('Page exceeds the 2 MB preview limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return { html: Buffer.concat(chunks).toString('utf8'), url: u.toString() };
  }
  throw Error('Too many redirects.');
}

async function extractProductData(rawUrl) {
  // 1. Try external Amazon adapters if keys are configured
  if (/amazon\./i.test(rawUrl)) {
    const keepa = await tryKeepaAdapter(rawUrl);
    if (keepa) return keepa;
    const rf = await tryRainforestAdapter(rawUrl);
    if (rf) return rf;
  }

  // 2. Try Shopify JSON fast-path for D2C stores
  const shopify = await tryShopifyJson(rawUrl);
  if (shopify) return shopify;

  // 3. Public HTML metadata + JSON-LD + store fallback
  const { html, url } = await fetchPublicHtml(rawUrl);
  const ld = productLd(html);
  const title = ld.title || meta(html, ['og:title', 'twitter:title']) || clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const description = ld.description || meta(html, ['og:description', 'description', 'twitter:description']);
  let image = ld.image || meta(html, ['og:image', 'og:image:secure_url', 'twitter:image']);
  try { if (image) image = new URL(image, url).toString(); } catch { image = ''; }
  const pr = ld.price ?? meta(html, ['product:price:amount', 'og:price:amount', 'price']) ?? extractStoreFallbackPrice(html, url);
  const price = pr == null || pr === '' ? null : Number(String(pr).replace(/[^\d.]/g, ''));
  const brand = ld.brand || meta(html, ['product:brand', 'og:site_name', 'application-name']);
  return withClothingType({
    title,
    description,
    image,
    price: Number.isFinite(price) && price > 0 ? price : null,
    brand,
    category: categoryFrom(url, title, description),
    finalUrl: url,
    method: 'html-metadata',
    fetchedAt: new Date().toISOString()
  });
}

function appendSnapshot(product, price, method) {
  if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0) return false;
  const numPrice = Number(price);
  if (!Array.isArray(product.priceHistory)) product.priceHistory = [];
  const last = product.priceHistory[product.priceHistory.length - 1];
  const now = Date.now();
  const lastTime = last ? new Date(last.recordedAt).getTime() : 0;
  // Record if price changed or at least 1 hour elapsed since last snapshot
  if (!last || Number(last.price) !== numPrice || (now - lastTime) >= 3600000) {
    product.priceHistory.push({ price: numPrice, recordedAt: new Date(now).toISOString(), method: method || 'manual' });
    if (product.priceHistory.length > 180) product.priceHistory = product.priceHistory.slice(-180);
  }
  product.price = numPrice;
  product.lastCheckedAt = new Date(now).toISOString();
  return true;
}

async function checkSingleProduct(product) {
  const extracted = await extractProductData(product.url);
  if (Array.isArray(extracted.history) && extracted.history.length && (!product.priceHistory || product.priceHistory.length < 2)) {
    product.priceHistory = extracted.history;
  }
  const updated = appendSnapshot(product, extracted.price, extracted.method);
  if (extracted.title && product.name.startsWith('Amazon product ·')) product.name = extracted.title;
  if (extracted.image && !product.image) product.image = extracted.image;
  return { updated, extracted, product: computeStats(product) };
}

async function runBatchTrack(userId) {
  const db = readUserDb(userId);
  const results = [];
  for (const p of db.products) {
    try {
      const res = await checkSingleProduct(p);
      results.push({ id: p.id, name: p.name, ok: true, price: p.price, method: res.extracted.method });
    } catch (e) {
      results.push({ id: p.id, name: p.name, ok: false, error: e.message });
    }
  }
  db.lastTrackRun = new Date().toISOString();
  writeUserDb(userId, db);
  return { lastTrackRun: db.lastTrackRun, results, products: db.products.map(computeStats) };
}

function readJsonBody(req) {
  if (req.body !== undefined) {
    try {
      if (typeof req.body === 'string') return Promise.resolve(JSON.parse(req.body || '{}'));
      if (Buffer.isBuffer(req.body)) return Promise.resolve(JSON.parse(req.body.toString('utf8') || '{}'));
      return Promise.resolve(req.body);
    } catch {
      return Promise.reject(Object.assign(Error('Invalid JSON request.'), { status: 400 }));
    }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > MAX_BODY) {
        req.destroy();
        reject(Object.assign(Error('Request too large.'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(Object.assign(Error('Invalid JSON request.'), { status: 400 })); }
    });
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('Request failed:', error.message);
    if (!res.headersSent) send(res, 500, { error: 'The request could not be completed.' });
    else res.destroy();
  });
});

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) && !requireSameOrigin(req)) {
    return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
  }

  // Serve UI directly at /
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    return send(res, 200, fs.readFileSync(htmlPath, 'utf8'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
    const hosted = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
    if (process.env.VERCEL && !hosted) {
      return send(res, 503, { ok: false, error: 'Hosted authentication is not configured.' });
    }
    return send(res, 200, {
      ok: true,
      service: hosted ? 'ONE/SHELF hosted price tracker' : 'ONE/SHELF self-hosted price tracker',
      mode: hosted ? 'hosted' : 'local',
      version: '1.0.0',
      trackIntervalHours: Number((TRACK_INTERVAL_MS / 3600000).toFixed(2)),
      adapters: {
        shopifyJson: true,
        htmlMetadata: true,
        keepaApi: Boolean(process.env.KEEPA_API_KEY),
        rainforestApi: Boolean(process.env.RAINFOREST_API_KEY)
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const hosted = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
    return send(res, 200, {
      mode: hosted ? 'hosted' : process.env.VERCEL ? 'misconfigured' : 'local',
      authProvider: hosted ? 'supabase' : process.env.VERCEL ? 'missing' : 'local'
    });
  }

  if (pathname.startsWith('/api/') && (process.env.SUPABASE_URL || process.env.SUPABASE_ANON_KEY || process.env.VERCEL)) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return send(res, 503, { error: 'Hosted authentication is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.' });
    }
    return handleHostedRequest(req, res, pathname, {
      send,
      readJsonBody,
      normalizeProduct,
      categoryFrom,
      inferClothingType,
      clothingTypeToDepartment,
      categoryValues: CATEGORY_VALUES,
      computeStats,
      canonicalProductUrl,
      appendSnapshot,
      checkSingleProduct,
      extractProductData
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    return send(res, 200, { hasAccounts: readAccounts().users.length > 0 });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = authenticatedUser(req);
    return user
      ? send(res, 200, { user })
      : send(res, 401, { error: 'Sign in to continue.' });
  }

  if (req.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    if (checkAuthRateLimit(req, res)) return;
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'Invalid account request.' });
      }
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return send(res, 400, { error: 'Enter a valid email address.' });
      }
      if (password.length > 128) return send(res, 400, { error: 'Password must be 128 characters or fewer.' });

      const store = readAccounts();
      let account;
      if (pathname === '/api/auth/register') {
        if (password.length < 10) return send(res, 400, { error: 'Use a password with at least 10 characters.' });
        if (store.users.some(user => user.email === email)) {
          return send(res, 409, { error: 'An account with that email already exists.' });
        }
        const salt = crypto.randomBytes(16);
        const passwordHash = await scrypt(password, salt, 64);
        account = {
          id: crypto.randomUUID(),
          email,
          salt: salt.toString('hex'),
          passwordHash: passwordHash.toString('hex'),
          createdAt: new Date().toISOString()
        };
        if (store.users.length === 0) {
          const legacy = readDb();
          writeUserDb(account.id, {
            products: legacy.products.map(normalizeProduct),
            lastTrackRun: legacy.lastTrackRun || null
          });
        } else {
          writeUserDb(account.id, { products: [], lastTrackRun: null });
        }
        store.users.push(account);
        writeJson(AUTH_FILE, store);
      } else {
        account = store.users.find(user => user.email === email);
        const salt = account ? Buffer.from(account.salt, 'hex') : Buffer.alloc(16);
        const expected = account ? Buffer.from(account.passwordHash, 'hex') : Buffer.alloc(64);
        const actual = await scrypt(password, salt, 64);
        if (!account || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          return send(res, 401, { error: 'Email or password is incorrect.' });
        }
      }

      clearAuthRateLimit(req);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: account.id, expiresAt: Date.now() + SESSION_TTL_MS });
      setSessionCookie(res, token);
      return send(res, pathname.endsWith('/register') ? 201 : 200, {
        user: { id: account.id, email: account.email }
      });
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : 'Account could not be saved.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = readCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  const user = authenticatedUser(req);
  if (pathname.startsWith('/api/') && !user) {
    return send(res, 401, { error: 'Sign in to continue.' });
  }

  if (req.method === 'GET' && pathname === '/api/products') {
    const db = readUserDb(user.id);
    return send(res, 200, { products: db.products.map(computeStats), lastTrackRun: db.lastTrackRun });
  }

  if (req.method === 'GET' && pathname === '/api/export') {
    const db = readUserDb(user.id);
    return send(res, 200, { exportedAt: new Date().toISOString(), products: db.products.map(computeStats) });
  }

  if (req.method === 'POST' && pathname === '/api/products/import') {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.products) || body.products.length > 200) {
        return send(res, 400, { error: 'Import must contain between 1 and 200 product links.' });
      }
      const db = readUserDb(user.id);
      const knownUrls = new Set(db.products.map(product => {
        try { return canonicalProductUrl(product.url); } catch { return ''; }
      }));
      const importedUrls = new Set();
      const added = [];
      let duplicates = 0;
      let invalid = 0;
      for (const item of body.products) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          invalid++;
          continue;
        }
        const name = String(item.name || '').trim();
        const rawUrl = String(item.url || '').trim();
        let parsedUrl;
        try { parsedUrl = new URL(rawUrl); } catch { parsedUrl = null; }
        if (!name || name.length > 300 || !parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) ||
            parsedUrl.username || parsedUrl.password || rawUrl.length > 4096) {
          invalid++;
          continue;
        }
        const canonical = canonicalProductUrl(rawUrl);
        if (knownUrls.has(canonical) || importedUrls.has(canonical)) {
          duplicates++;
          continue;
        }
        const category = CATEGORY_VALUES.has(item.category) ? item.category : categoryFrom(rawUrl, name, '');
        const inferred = inferClothingType({ category, url: rawUrl, name });
        const selectedDepartment = CLOTHING_TYPES[item.department]?.includes(item.clothingType) &&
          clothingTypeToDepartment.get(item.clothingType) === item.department
          ? item.department
          : inferred.department;
        const selectedType = CLOTHING_TYPES[selectedDepartment]?.includes(item.clothingType)
          ? item.clothingType
          : inferred.clothingType;
        const product = normalizeProduct({
          id: 'p-' + crypto.randomUUID(),
          name,
          brand: String(item.brand || '').trim().slice(0, 100),
          url: rawUrl,
          category,
          department: selectedDepartment,
          clothingType: selectedType,
          price: null,
          targetPrice: null,
          notes: String(item.notes || 'Imported from a product list. Verify the estimated title and category; price and image were not imported.').slice(0, 1200),
          image: '',
          tags: [],
          added: Date.now(),
          saved: false,
          priceHistory: []
        });
        added.push(product);
        knownUrls.add(canonical);
        importedUrls.add(canonical);
      }
      if (added.length) {
        db.products = [...added.reverse(), ...db.products];
        writeUserDb(user.id, db);
      }
      return send(res, 200, { added: added.length, duplicates, invalid, products: added.map(computeStats) });
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : 'Products could not be imported.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/products') {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, { error: 'Invalid product request.' });
      }
      const productName = String(body.name || '').trim();
      const productUrl = String(body.url || '').trim();
      let parsedUrl;
      try { parsedUrl = new URL(productUrl); } catch { parsedUrl = null; }
      if (!productName || !parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        return send(res, 400, { error: 'A product name and valid public HTTP/HTTPS URL are required.' });
      }
      if (productName.length > 300 || productUrl.length > 4096) return send(res, 400, { error: 'Product name or URL is too long.' });
      const category = CATEGORY_VALUES.has(body.category) ? body.category : null;
      if (!category) return send(res, 400, { error: 'Choose a valid product category.' });
      const price = body.price === '' || body.price == null ? null : Number(body.price);
      const targetPrice = body.targetPrice === '' || body.targetPrice == null ? null : Number(body.targetPrice);
      if ((price != null && (!Number.isFinite(price) || price < 0)) ||
          (targetPrice != null && (!Number.isFinite(targetPrice) || targetPrice < 0))) {
        return send(res, 400, { error: 'Prices must be valid non-negative numbers.' });
      }
      if (typeof body.image === 'string' && body.image.length > 2800000) {
        return send(res, 413, { error: 'Product image must be smaller than 2 MB.' });
      }
      const db = readUserDb(user.id);
      const idx = db.products.findIndex(x => x.id === body.id);
      const existing = idx >= 0 ? db.products[idx] : null;
      const product = normalizeProduct({
        id: body.id || 'p-' + Date.now(),
        name: productName,
        brand: String(body.brand || '').trim(),
        url: productUrl,
        category,
        department: body.department,
        clothingType: body.clothingType,
        price,
        targetPrice,
        notes: String(body.notes || '').trim(),
        image: String(body.image || existing?.image || ''),
        tags: Array.isArray(body.tags) ? body.tags : (existing?.tags || []),
        added: existing?.added || body.added || Date.now(),
        saved: typeof body.saved === 'boolean' ? body.saved : (existing?.saved || false),
        priceHistory: Array.isArray(existing?.priceHistory) ? existing.priceHistory : (Array.isArray(body.priceHistory) ? body.priceHistory : [])
      });
      if (product.price != null) appendSnapshot(product, product.price, 'manual');
      if (idx >= 0) db.products[idx] = product;
      else db.products.unshift(product);
      writeUserDb(user.id, db);
      return send(res, 200, { product: computeStats(product) });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : 'Product could not be saved.' });
    }
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/products/')) {
    const id = decodeURIComponent(pathname.slice('/api/products/'.length));
    const db = readUserDb(user.id);
    const next = db.products.filter(p => p.id !== id);
    if (next.length === db.products.length) return send(res, 404, { error: 'Product not found.' });
    db.products = next;
    writeUserDb(user.id, db);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && /^\/api\/products\/[^/]+\/check$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    const db = readUserDb(user.id);
    const product = db.products.find(p => p.id === id);
    if (!product) return send(res, 404, { error: 'Product not found.' });
    try {
      const result = await checkSingleProduct(product);
      writeUserDb(user.id, db);
      return send(res, 200, result);
    } catch (e) {
      return send(res, 422, { error: e.message || 'Could not refresh price.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/track-all') {
    const summary = await runBatchTrack(user.id);
    return send(res, 200, summary);
  }

  if (req.method === 'POST' && pathname === '/api/preview') {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.url !== 'string' || body.url.length > 4096) {
        return send(res, 400, { error: 'A product URL is required.' });
      }
      const data = await extractProductData(body.url);
      return send(res, 200, data);
    } catch (e) {
      return send(res, e.status || 422, { error: e.message || 'Could not extract metadata.' });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

if (require.main === module) {
  ensureDb();
  if (TRACK_INTERVAL_MS > 0 && !process.env.SUPABASE_URL) {
    setInterval(() => {
      try {
        for (const account of readAccounts().users) {
          runBatchTrack(account.id).catch(err => console.error('Scheduled price check failed:', err.message));
        }
      } catch (err) {
        console.error('Scheduled price check failed:', err.message);
      }
    }, TRACK_INTERVAL_MS).unref();
  }
  server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : PORT;
    console.log(`ONE/SHELF running at http://localhost:${port}`);
    console.log(`Local DB: ${DB_FILE}`);
    console.log(`Adapters: Shopify JSON [ON], Public HTML/JSON-LD [ON], Keepa [${process.env.KEEPA_API_KEY ? 'ON' : 'OFF'}], Rainforest [${process.env.RAINFOREST_API_KEY ? 'ON' : 'OFF'}]`);
  });
}

module.exports = {
  handleRequest,
  checkSingleProduct,
  runBatchTrack,
  normalizeProduct,
  categoryFrom,
  inferClothingType,
  clothingTypeToDepartment,
  CATEGORY_VALUES,
  computeStats,
  canonicalProductUrl,
  appendSnapshot,
  extractProductData
};