const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const root = __dirname;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-test-'));
const legacyProduct = {
  id: 'legacy-shirt',
  name: 'Legacy cotton shirt',
  brand: 'Example',
  url: 'https://example.com/products/cotton-shirt',
  category: 'fashion',
  price: 1200,
  notes: '',
  image: '',
  saved: false,
  added: 1,
  priceHistory: []
};
fs.writeFileSync(path.join(dataDir, 'shelf-db.json'), JSON.stringify({ products: [legacyProduct], lastTrackRun: null }));

let server;
let baseUrl;
let output = '';

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Server did not start. Output: ${output}`)), 10000);
    const onData = chunk => {
      output += chunk.toString();
      const match = output.match(/ONE\/SHELF running at http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      server.stdout.off('data', onData);
      baseUrl = `http://127.0.0.1:${match[1]}`;
      resolve();
    };
    server.stdout.on('data', onData);
    server.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', code => {
      if (baseUrl) return;
      clearTimeout(timer);
      reject(Error(`Server exited with ${code}. Output: ${output}`));
    });
  });
}

async function request(pathname, { method = 'GET', cookie, origin = baseUrl, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { response, data };
}

async function register(email, password = 'correct horse battery staple') {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { email, password }
  });
  return {
    ...result,
    cookie: result.response.headers.get('set-cookie')?.split(';')[0]
  };
}

before(async () => {
  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: '0', TRACK_INTERVAL_MS: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForServer();
});

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise(resolve => {
      server.once('exit', resolve);
      server.kill();
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('homepage, local authentication, account isolation, and clothing fields work', async () => {
  const homepage = await fetch(baseUrl + '/');
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /ONE\/SHELF/);
  assert.match(homepageHtml, /id="togglePassword"/);
  assert.match(homepageHtml, /price-desc/);
  const config = await request('/api/config');
  assert.equal(config.data.mode, 'local');
  const health = await request('/api/health');
  assert.equal(health.data.mode, 'local');

  const anonymous = await request('/api/products');
  assert.equal(anonymous.response.status, 401);

  const first = await register('  Alice@Example.com ');
  assert.equal(first.response.status, 201);
  assert.match(first.cookie, /^oneshelf_session=/);
  assert.match(first.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(first.response.headers.get('set-cookie'), /SameSite=Strict/);

  const imported = await request('/api/products', { cookie: first.cookie });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.products.length, 1);
  assert.equal(imported.data.products[0].department, 'topwear');
  assert.equal(imported.data.products[0].clothingType, 'shirt');

  const added = await request('/api/products', {
    method: 'POST',
    cookie: first.cookie,
    body: {
      name: 'Relaxed fit track pants',
      brand: 'Example',
      url: 'https://example.com/products/relaxed-fit-track-pants',
      category: 'fashion',
      department: 'bottomwear',
      clothingType: 'track-pants',
      price: 1800,
      targetPrice: 1500,
      notes: '',
      image: ''
    }
  });
  assert.equal(added.response.status, 200);
  assert.equal(added.data.product.department, 'bottomwear');
  assert.equal(added.data.product.clothingType, 'track-pants');

  const importedBatch = await request('/api/products/import', {
    method: 'POST',
    cookie: first.cookie,
    body: {
      products: [
        {
          name: 'Cushion Men Slipper',
          brand: 'Example',
          url: 'https://example.com/products/cushion-men-slipper?utm_source=list',
          category: 'fashion'
        },
        {
          name: 'KZ ZSN Pro',
          brand: 'KZ',
          url: 'https://example.com/products/kz-zsn-pro.html',
          category: 'tech'
        },
        {
          name: 'Mens boxer shorts',
          brand: 'Example',
          url: 'https://example.com/products/mens-boxer-shorts',
          category: 'fashion',
          department: 'underwear',
          clothingType: 'boxers'
        },
        {
          name: 'Duplicate Slipper',
          url: 'https://example.com/products/cushion-men-slipper'
        }
      ]
    }
  });
  assert.equal(importedBatch.response.status, 200);
  assert.equal(importedBatch.data.added, 3);
  assert.equal(importedBatch.data.duplicates, 1);
  const importedFootwear = importedBatch.data.products.find(product => product.name === 'Cushion Men Slipper');
  assert.equal(importedFootwear.department, 'footwear');
  assert.equal(importedFootwear.clothingType, 'slippers');
  const importedUnderwear = importedBatch.data.products.find(product => product.name === 'Mens boxer shorts');
  assert.equal(importedUnderwear.department, 'underwear');
  assert.equal(importedUnderwear.clothingType, 'boxers');

  const accessory = await request('/api/products', {
    method: 'POST',
    cookie: first.cookie,
    body: {
      name: 'Leather wallet',
      brand: 'Example',
      url: 'https://example.com/products/leather-wallet',
      category: 'accessories'
    }
  });
  assert.equal(accessory.response.status, 200);
  assert.equal(accessory.data.product.category, 'accessories');

  const invalidPrice = await request('/api/products', {
    method: 'POST',
    cookie: first.cookie,
    body: { name: 'Bad price', url: 'https://example.com/p', category: 'tech', price: -1 }
  });
  assert.equal(invalidPrice.response.status, 400);

  const second = await register('bob@example.com');
  assert.equal(second.response.status, 201);
  const secondShelf = await request('/api/products', { cookie: second.cookie });
  assert.equal(secondShelf.response.status, 200);
  assert.deepEqual(secondShelf.data.products, []);

  const firstShelf = await request('/api/products', { cookie: first.cookie });
  assert.equal(firstShelf.data.products.length, 6);
  assert.ok(firstShelf.data.products.some(product => product.clothingType === 'track-pants'));

  const crossOrigin = await request('/api/products', {
    method: 'POST',
    cookie: first.cookie,
    origin: 'http://attacker.example',
    body: { name: 'Blocked', url: 'https://example.com', category: 'other' }
  });
  assert.equal(crossOrigin.response.status, 403);

  const duplicate = await register('alice@example.com');
  assert.equal(duplicate.response.status, 409);

  const logout = await request('/api/auth/logout', { method: 'POST', cookie: second.cookie });
  assert.equal(logout.response.status, 200);
  const afterLogout = await request('/api/products', { cookie: second.cookie });
  assert.equal(afterLogout.response.status, 401);

  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
  assert.ok(accounts.users.every(user => !user.passwordHash.includes('correct horse battery staple')));
});
