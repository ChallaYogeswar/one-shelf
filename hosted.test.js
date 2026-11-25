const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const root = __dirname;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shelf-hosted-test-'));
const accounts = new Map();
const tokens = new Map();
const products = new Map();
let supabase;
let server;
let baseUrl;
let output = '';

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(value == null ? '' : JSON.stringify(value));
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function getUser(req) {
  return tokens.get(String(req.headers.authorization || '').replace(/^Bearer /i, ''));
}

supabase = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.headers.apikey !== 'test-anon-key') return sendJson(res, 401, { message: 'Invalid key.' });

  if (url.pathname === '/auth/v1/signup' || url.pathname === '/auth/v1/token') {
    const body = await bodyJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    let account = accounts.get(email);
    if (url.pathname.endsWith('/signup')) {
      if (account) return sendJson(res, 422, { message: 'User already registered.' });
      const id = `00000000-0000-4000-8000-${String(accounts.size + 1).padStart(12, '0')}`;
      account = {
        user: { id, email },
        token: `access-token-${accounts.size + 1}-xxxxxxxxxxxxxxxx`,
        refresh: `refresh-token-${accounts.size + 1}`
      };
      accounts.set(email, account);
    }
    if (!account) return sendJson(res, 400, { message: 'Invalid login credentials.' });
    tokens.set(account.token, account.user);
    return sendJson(res, 200, {
      access_token: account.token,
      refresh_token: account.refresh,
      expires_in: 3600,
      user: account.user
    });
  }

  if (url.pathname === '/auth/v1/user') {
    const user = getUser(req);
    if (user && req.method === 'PUT') return sendJson(res, 200, user);
    return user ? sendJson(res, 200, user) : sendJson(res, 401, { message: 'Invalid token.' });
  }
  if (url.pathname === '/auth/v1/recover') return sendJson(res, 200, { message: 'Recovery request accepted.' });
  if (url.pathname === '/auth/v1/logout') return sendJson(res, 204, null);

  const user = getUser(req);
  if (!user) return sendJson(res, 401, { message: 'Unauthorized.' });
  if (url.pathname === '/rest/v1/products') {
    if (req.method === 'GET') {
      let rows = [...(products.get(user.id) || [])];
      const id = url.searchParams.get('id');
      if (id?.startsWith('eq.')) rows = rows.filter(row => row.id === id.slice(3));
      return sendJson(res, 200, rows);
    }
    if (req.method === 'POST') {
      const body = await bodyJson(req);
      const rows = Array.isArray(body) ? body : [body];
      const shelf = products.get(user.id) || [];
      for (const row of rows) {
        if (row.user_id !== user.id) return sendJson(res, 403, { message: 'Row-level security violation.' });
        const index = shelf.findIndex(item => item.id === row.id);
        if (index >= 0) shelf[index] = row;
        else shelf.push(row);
      }
      products.set(user.id, shelf);
      return sendJson(res, 201, rows);
    }
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id')?.slice(3);
      products.set(user.id, (products.get(user.id) || []).filter(row => row.id !== id));
      return sendJson(res, 204, null);
    }
  }
  if (url.pathname === '/rest/v1/user_settings') return sendJson(res, 200, [{ last_track_run: null }]);
  return sendJson(res, 404, { message: 'Not found.' });
});

function waitForApp() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Hosted API did not start. Output: ${output}`)), 10000);
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
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => {
      if (!baseUrl) { clearTimeout(timer); reject(Error(`Hosted API exited with ${code}. ${output}`)); }
    });
  });
}

async function request(pathname, { method = 'GET', cookie, body, origin = baseUrl } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

before(async () => {
  await new Promise(resolve => supabase.listen(0, '127.0.0.1', resolve));
  const supabasePort = supabase.address().port;
  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: '0',
      TRACK_INTERVAL_MS: '0',
      DATA_DIR: dataDir,
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  await waitForApp();
});

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  }
  if (supabase && supabase.listening) await new Promise(resolve => supabase.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('hosted auth uses HttpOnly cookies and product rows stay user-scoped', async () => {
  const config = await request('/api/config');
  assert.equal(config.data.mode, 'hosted');
  const health = await request('/api/health');
  assert.equal(health.data.mode, 'hosted');
  const first = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'a long test password' }
  });
  assert.equal(first.response.status, 201);
  const firstCookies = first.response.headers.getSetCookie();
  const firstCookie = firstCookies.map(value => value.split(';')[0]).join('; ');
  assert.ok(firstCookies.some(value => /HttpOnly/i.test(value)));
  assert.ok(firstCookies.some(value => /SameSite=Lax/i.test(value)));

  const me = await request('/api/auth/me', { cookie: firstCookie });
  assert.equal(me.data.user.email, 'alice@example.com');
  const recovery = await request('/api/auth/recovery', {
    method: 'POST',
    body: { email: 'alice@example.com' }
  });
  assert.equal(recovery.response.status, 200);
  const passwordReset = await request('/api/auth/password', {
    method: 'POST',
    body: { token: 'access-token-1-xxxxxxxxxxxxxxxx', password: 'a different long password' }
  });
  assert.equal(passwordReset.response.status, 200);
  const add = await request('/api/products', {
    method: 'POST',
    cookie: firstCookie,
    body: {
      name: 'Cotton shirt',
      brand: 'Example',
      url: 'https://example.com/products/cotton-shirt',
      category: 'fashion',
      department: 'topwear',
      clothingType: 'shirt',
      price: 1200
    }
  });
  assert.equal(add.response.status, 200);
  assert.equal(add.data.product.department, 'topwear');

  const invalidImage = await request('/api/products', {
    method: 'POST',
    cookie: firstCookie,
    body: {
      name: 'Invalid image upload',
      url: 'https://example.com/products/image',
      category: 'other',
      image: 'data:image/png;base64,SGVsbG8='
    }
  });
  assert.equal(invalidImage.response.status, 400);

  const shelf = await request('/api/products', { cookie: firstCookie });
  assert.equal(shelf.data.products.length, 1);
  assert.equal(shelf.data.products[0].stats.currentPrice, 1200);
  assert.equal(products.get(me.data.user.id)[0].user_id, me.data.user.id);

  const imported = await request('/api/products/import', {
    method: 'POST',
    cookie: firstCookie,
    body: {
      products: [{
        name: 'Leather wallet',
        brand: 'Example',
        url: 'https://example.com/products/leather-wallet',
        category: 'accessories'
      }]
    }
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.added, 1);
  assert.equal(imported.data.products[0].category, 'accessories');

  const second = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'bob@example.com', password: 'another long test password' }
  });
  const secondCookie = second.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const secondShelf = await request('/api/products', { cookie: secondCookie });
  assert.equal(secondShelf.response.status, 200);
  assert.deepEqual(secondShelf.data.products, []);
  const loggedOut = await request('/api/auth/logout', { method: 'POST', cookie: secondCookie });
  assert.equal(loggedOut.response.status, 200);
  assert.ok(loggedOut.response.headers.getSetCookie().every(value => /Max-Age=0/i.test(value)));

  const blocked = await request('/api/products', {
    method: 'POST',
    cookie: firstCookie,
    origin: 'http://attacker.example',
    body: { name: 'Blocked', url: 'https://example.com', category: 'other' }
  });
  assert.equal(blocked.response.status, 403);
});
