const crypto = require('node:crypto');
const { getSupabaseConfig, supabaseRequest, productFromRow, productToRow } = require('./supabase-rest');

const ACCESS_COOKIE = 'oneshelf_access';
const REFRESH_COOKIE = 'oneshelf_refresh';
const IMAGE_PREFIX = 'storage://product-images/';
const IMAGE_BUCKET = 'product-images';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const split = part.indexOf('=');
    if (split > 0) result[part.slice(0, split).trim()] = part.slice(split + 1).trim();
  }
  return result;
}

function setSessionCookies(req, res, session) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  const flags = `HttpOnly; SameSite=Lax; Path=/;${secure ? ' Secure;' : ''}`;
  const accessAge = Math.max(60, Number(session.expires_in) || 3600);
  res.setHeader('Set-Cookie', [
    `${ACCESS_COOKIE}=${session.access_token}; ${flags} Max-Age=${accessAge}`,
    `${REFRESH_COOKIE}=${session.refresh_token}; ${flags} Max-Age=2592000`
  ]);
}

function clearSessionCookies(req, res) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
  const flags = `HttpOnly; SameSite=Lax; Path=/;${secure ? ' Secure;' : ''} Max-Age=0`;
  res.setHeader('Set-Cookie', [`${ACCESS_COOKIE}=; ${flags}`, `${REFRESH_COOKIE}=; ${flags}`]);
}

function providerMessage(error) {
  const message = String(error.message || '');
  if (/invalid login credentials|invalid email or password/i.test(message)) return 'Email or password is incorrect.';
  if (/already registered|already exists/i.test(message)) return 'An account with that email already exists.';
  if (/password/i.test(message)) return message;
  return 'The hosted authentication service could not complete the request.';
}

async function authRequest(path, body) {
  return (await supabaseRequest(path, { method: 'POST', body })).data;
}

async function currentHostedUser(req, res) {
  let session = cookies(req);
  if (!session[ACCESS_COOKIE] && !session[REFRESH_COOKIE]) return null;
  if (session[ACCESS_COOKIE]) {
    try {
      const user = (await supabaseRequest('/auth/v1/user', { token: session[ACCESS_COOKIE] })).data;
      return user ? { user, accessToken: session[ACCESS_COOKIE] } : null;
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
    }
  }
  if (!session[REFRESH_COOKIE]) {
    clearSessionCookies(req, res);
    return null;
  }
  try {
    const refreshed = await authRequest('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: session[REFRESH_COOKIE]
    });
    if (!refreshed.access_token || !refreshed.refresh_token) throw Error('Supabase returned an invalid refreshed session.');
    setSessionCookies(req, res, refreshed);
    return { user: refreshed.user, accessToken: refreshed.access_token };
  } catch (error) {
    if (error.status === 401 || error.status === 400) {
      clearSessionCookies(req, res);
      return null;
    }
    throw error;
  }
}

function toClientProduct(product) {
  const output = product;
  if (output.image && output.image.startsWith(IMAGE_PREFIX)) {
    output.image = `/api/products/${encodeURIComponent(output.id)}/image`;
  }
  return output;
}

function errorStatus(error) {
  if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.status === 413) {
    return error.status;
  }
  return 500;
}

async function dbRequest(path, user, options = {}) {
  return (await supabaseRequest(path, { ...options, token: user.accessToken })).data;
}

async function getProducts(user) {
  const rows = await dbRequest('/rest/v1/products?select=*&order=added.desc', user);
  return rows.map(row => toClientProduct(productFromRow(row)));
}

async function getSettings(user) {
  const rows = await dbRequest(
    `/rest/v1/user_settings?select=last_track_run&user_id=eq.${encodeURIComponent(user.user.id)}&limit=1`,
    user
  );
  return rows[0]?.last_track_run || null;
}

async function findProduct(user, id) {
  const rows = await dbRequest(
    `/rest/v1/products?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    user
  );
  return rows[0] || null;
}

function decodeImageData(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw Object.assign(Error('Uploaded image must be a JPEG, PNG, WebP, or GIF.'), { status: 400 });
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(Error('Product image must be smaller than 2 MB.'), { status: 413 });
  }
  const contentType = match[1].toLowerCase();
  const signatures = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    'image/gif': bytes.toString('ascii', 0, 4) === 'GIF8'
  };
  if (!signatures[contentType]) throw Object.assign(Error('The uploaded file is not a valid image.'), { status: 400 });
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType];
  return { bytes, contentType, extension };
}

function imageObjectPath(userId, productId, extension) {
  const safeId = String(productId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${userId}/${safeId}.${extension}`;
}

async function uploadProductImage(dataUrl, user, productId) {
  const { bytes, contentType, extension } = decodeImageData(dataUrl);
  const objectPath = imageObjectPath(user.user.id, productId, extension);
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  await supabaseRequest(`/storage/v1/object/${IMAGE_BUCKET}/${encodedPath}`, {
    method: 'POST',
    token: user.accessToken,
    body: bytes,
    headers: { 'Content-Type': contentType, 'x-upsert': 'true' }
  });
  return `${IMAGE_PREFIX}${objectPath}`;
}

async function removeStoredImage(image, user) {
  if (!image || !image.startsWith(IMAGE_PREFIX)) return;
  const objectPath = image.slice(IMAGE_PREFIX.length);
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  await supabaseRequest(`/storage/v1/object/${IMAGE_BUCKET}/${encodedPath}`, {
    method: 'DELETE',
    token: user.accessToken
  });
}

async function saveProduct(product, user) {
  const row = productToRow(product, user.user.id);
  await dbRequest('/rest/v1/products?on_conflict=id', user, {
    method: 'POST',
    body: row,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' }
  });
}

async function authenticatedRequest(req, res) {
  const user = await currentHostedUser(req, res);
  if (!user || !user.user?.id) return null;
  return user;
}

async function handleHostedRequest(req, res, pathname, helpers) {
  const { send, readJsonBody, normalizeProduct, categoryFrom, inferClothingType, clothingTypeToDepartment, categoryValues, computeStats, canonicalProductUrl, appendSnapshot, checkSingleProduct, extractProductData } = helpers;

  if (req.method === 'GET' && pathname === '/api/config') {
    return send(res, 200, { mode: 'hosted', authProvider: 'supabase' });
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      service: 'ONE/SHELF hosted price tracker',
      mode: 'hosted',
      adapters: {
        shopifyJson: true,
        htmlMetadata: true,
        keepaApi: Boolean(process.env.KEEPA_API_KEY),
        rainforestApi: Boolean(process.env.RAINFOREST_API_KEY)
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    return send(res, 200, { hasAccounts: true });
  }

  if (req.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    try {
      const body = await readJsonBody(req);
      const email = String(body?.email || '').trim().toLowerCase();
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return send(res, 400, { error: 'Enter a valid email address.' });
      }
      if (password.length > 128 || (pathname.endsWith('/register') && password.length < 10)) {
        return send(res, 400, { error: 'Use a password between 10 and 128 characters.' });
      }
      const result = pathname.endsWith('/register')
        ? await authRequest('/auth/v1/signup', { email, password })
        : await authRequest('/auth/v1/token?grant_type=password', { email, password });
      const session = result.session || (result.access_token ? result : null);
      if (session?.access_token && session?.refresh_token) setSessionCookies(req, res, session);
      const user = session?.user || result.user;
      if (!user?.id) return send(res, 502, { error: 'The authentication provider returned an invalid response.' });
      return send(res, pathname.endsWith('/register') ? 201 : 200, {
        user: { id: user.id, email: user.email },
        requiresEmailConfirmation: !session?.access_token
      });
    } catch (error) {
      const status = pathname.endsWith('/register') && error.status === 422 ? 409 : errorStatus(error);
      return send(res, status, { error: providerMessage(error) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/recovery') {
    try {
      const body = await readJsonBody(req);
      const email = String(body?.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return send(res, 400, { error: 'Enter a valid email address.' });
      }
      await authRequest('/auth/v1/recover', { email });
      return send(res, 200, { ok: true, message: 'If that email has an account, password reset instructions have been sent.' });
    } catch (error) {
      console.error('Hosted password recovery request failed:', error.message);
      return send(res, 503, { error: 'Password recovery is temporarily unavailable.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/password') {
    try {
      const body = await readJsonBody(req);
      const token = typeof body?.token === 'string' ? body.token : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      if (token.length < 20 || token.length > 4096) return send(res, 400, { error: 'The password reset link is invalid or expired.' });
      if (password.length < 10 || password.length > 128) return send(res, 400, { error: 'Use a password between 10 and 128 characters.' });
      await supabaseRequest('/auth/v1/user', { method: 'PUT', token, body: { password } });
      return send(res, 200, { ok: true });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        return send(res, 400, { error: 'The password reset link is invalid or expired.' });
      }
      if (error.status === 422) return send(res, 400, { error: providerMessage(error) });
      return send(res, 503, { error: 'The password could not be updated.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const session = cookies(req);
    try {
      let accessToken = session[ACCESS_COOKIE];
      let revoked = false;
      if (accessToken) {
        try {
          await supabaseRequest('/auth/v1/logout', { method: 'POST', token: accessToken });
          revoked = true;
        } catch (error) {
          if (error.status !== 401 && error.status !== 403) throw error;
        }
      }
      if (!revoked && session[REFRESH_COOKIE]) {
        const refreshed = await authRequest('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: session[REFRESH_COOKIE]
        });
        if (refreshed.access_token) {
          await supabaseRequest('/auth/v1/logout', { method: 'POST', token: refreshed.access_token });
        }
      }
      clearSessionCookies(req, res);
      return send(res, 200, { ok: true });
    } catch (error) {
      clearSessionCookies(req, res);
      return send(res, errorStatus(error), { error: 'Signed out on this device, but the provider could not revoke the session.' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    try {
      const user = await authenticatedRequest(req, res);
      return user
        ? send(res, 200, { user: { id: user.user.id, email: user.user.email } })
        : send(res, 401, { error: 'Sign in to continue.' });
    } catch {
      return send(res, 503, { error: 'The hosted authentication service is unavailable.' });
    }
  }

  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/cron/')) {
    let user;
    try { user = await authenticatedRequest(req, res); }
    catch {
      return send(res, 503, { error: 'The hosted authentication service is unavailable.' });
    }
    if (!user) return send(res, 401, { error: 'Sign in to continue.' });

    if (req.method === 'GET' && pathname === '/api/products') {
      try {
        const [products, lastTrackRun] = await Promise.all([getProducts(user), getSettings(user)]);
        return send(res, 200, { products: products.map(computeStats), lastTrackRun });
      } catch {
        return send(res, 503, { error: 'Could not load products from the hosted database.' });
      }
    }

    if (req.method === 'GET' && pathname === '/api/export') {
      try {
        const products = await getProducts(user);
        return send(res, 200, { exportedAt: new Date().toISOString(), products: products.map(computeStats) });
      } catch {
        return send(res, 503, { error: 'Could not export products from the hosted database.' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/products/import') {
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.products) || body.products.length > 200) {
          return send(res, 400, { error: 'Import must contain no more than 200 product links.' });
        }
        const existing = await getProducts(user);
        const knownUrls = new Set(existing.map(product => {
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
          const category = categoryValues.has(item.category) ? item.category : categoryFrom(rawUrl, name, '');
          const inferred = inferClothingType({ category, url: rawUrl, name });
          const department = clothingTypeToDepartment.get(item.clothingType) === item.department
            ? item.department
            : inferred.department;
          const product = normalizeProduct({
            id: `p-${crypto.randomUUID()}`,
            name,
            brand: String(item.brand || '').trim().slice(0, 100),
            url: rawUrl,
            category,
            department,
            clothingType: item.clothingType,
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
          const rows = added.map(product => productToRow(product, user.user.id));
          await dbRequest('/rest/v1/products', user, { method: 'POST', body: rows, headers: { Prefer: 'return=representation' } });
        }
        return send(res, 200, { added: added.length, duplicates, invalid, products: added.map(computeStats) });
      } catch (error) {
        return send(res, errorStatus(error), { error: error.status ? error.message : 'Products could not be imported.' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/products') {
      let uploadedImage = '';
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Invalid product request.' });
        const productName = String(body.name || '').trim();
        const productUrl = String(body.url || '').trim();
        let parsedUrl;
        try { parsedUrl = new URL(productUrl); } catch { parsedUrl = null; }
        if (!productName || !parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
          return send(res, 400, { error: 'A product name and valid public HTTP/HTTPS URL are required.' });
        }
        if (productName.length > 300 || productUrl.length > 4096) return send(res, 400, { error: 'Product name or URL is too long.' });
        const category = categoryValues.has(body.category) ? body.category : null;
        if (!category) return send(res, 400, { error: 'Choose a valid product category.' });
        const price = body.price === '' || body.price == null ? null : Number(body.price);
        const targetPrice = body.targetPrice === '' || body.targetPrice == null ? null : Number(body.targetPrice);
        if ((price != null && (!Number.isFinite(price) || price < 0)) ||
            (targetPrice != null && (!Number.isFinite(targetPrice) || targetPrice < 0))) {
          return send(res, 400, { error: 'Prices must be valid non-negative numbers.' });
        }
        if (typeof body.image === 'string' && body.image.length > 2800000) return send(res, 413, { error: 'Product image must be smaller than 2 MB.' });
        const existingRow = body.id ? await findProduct(user, String(body.id)) : null;
        const existing = existingRow ? productFromRow(existingRow) : null;
        const productId = existing?.id || String(body.id || `p-${crypto.randomUUID()}`);
        if (productId.length > 150) return send(res, 400, { error: 'Product identifier is too long.' });
        let image = String(body.image || existing?.image || '');
        if (image.startsWith('data:')) {
          image = await uploadProductImage(image, user, productId);
          uploadedImage = image;
        } else if (image.startsWith('/api/products/') && existing) {
          image = existing.image;
        }
        if (image && !image.startsWith(IMAGE_PREFIX)) {
          let imageUrl;
          try { imageUrl = new URL(image); } catch { imageUrl = null; }
          if (!imageUrl || !['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password) {
            return send(res, 400, { error: 'Use a valid public image URL.' });
          }
        }
        const product = normalizeProduct({
          id: productId,
          name: productName,
          brand: String(body.brand || '').trim().slice(0, 100),
          url: productUrl,
          category,
          department: body.department,
          clothingType: body.clothingType,
          price,
          targetPrice,
          notes: String(body.notes || '').trim().slice(0, 1200),
          image,
          tags: Array.isArray(body.tags) ? body.tags : (existing?.tags || []),
          added: existing?.added || body.added || Date.now(),
          saved: typeof body.saved === 'boolean' ? body.saved : (existing?.saved || false),
          priceHistory: existing?.priceHistory || (Array.isArray(body.priceHistory) ? body.priceHistory : [])
        });
        if (product.price != null) appendSnapshot(product, product.price, 'manual');
        await saveProduct(product, user);
        if (existing?.image?.startsWith(IMAGE_PREFIX) && existing.image !== image) {
          try { await removeStoredImage(existing.image, user); }
          catch (error) { console.error('Old product image cleanup failed:', error.message); }
        }
        return send(res, 200, { product: computeStats(toClientProduct(product)) });
      } catch (error) {
        if (uploadedImage) {
          try { await removeStoredImage(uploadedImage, user); }
          catch (cleanupError) { console.error('Temporary product image cleanup failed:', cleanupError.message); }
        }
        return send(res, errorStatus(error), { error: error.status ? error.message : 'Product could not be saved.' });
      }
    }

    const imageMatch = pathname.match(/^\/api\/products\/([^/]+)\/image$/);
    if (req.method === 'GET' && imageMatch) {
      try {
        const row = await findProduct(user, decodeURIComponent(imageMatch[1]));
        if (!row?.image?.startsWith(IMAGE_PREFIX)) return send(res, 404, { error: 'Product image not found.' });
        const objectPath = row.image.slice(IMAGE_PREFIX.length);
        const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
        const config = getSupabaseConfig();
        const response = await fetch(`${config.url}/storage/v1/object/authenticated/${IMAGE_BUCKET}/${encodedPath}`, {
          headers: { apikey: config.anonKey, Authorization: `Bearer ${user.accessToken}` }
        });
        if (!response.ok) return send(res, 404, { error: 'Product image not found.' });
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const bytes = Buffer.from(await response.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(bytes);
      } catch {
        return send(res, 503, { error: 'Could not load product image.' });
      }
    }

    const checkMatch = pathname.match(/^\/api\/products\/([^/]+)\/check$/);
    if (req.method === 'POST' && checkMatch) {
      try {
        const row = await findProduct(user, decodeURIComponent(checkMatch[1]));
        if (!row) return send(res, 404, { error: 'Product not found.' });
        const product = productFromRow(row);
        const result = await checkSingleProduct(product);
        await saveProduct(product, user);
        result.product = toClientProduct(result.product);
        return send(res, 200, result);
      } catch (error) {
        return send(res, 422, { error: error.message || 'Could not refresh price.' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/track-all') {
      return send(res, 200, {
        backgroundTracking: true,
        message: 'Background price checks run every six hours. Use the per-product Check price button for an immediate check.',
        products: (await getProducts(user)).map(computeStats),
        results: []
      });
    }

    if (req.method === 'POST' && pathname === '/api/preview') {
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.url !== 'string' || body.url.length > 4096) {
          return send(res, 400, { error: 'A product URL is required.' });
        }
        return send(res, 200, await extractProductData(body.url));
      } catch (error) {
        return send(res, error.status || 422, { error: error.message || 'Could not extract metadata.' });
      }
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/products/')) {
      try {
        const id = decodeURIComponent(pathname.slice('/api/products/'.length));
        if (id.includes('/')) return send(res, 404, { error: 'Product not found.' });
        const existing = await findProduct(user, id);
        if (!existing) return send(res, 404, { error: 'Product not found.' });
        await dbRequest(`/rest/v1/products?id=eq.${encodeURIComponent(id)}`, user, { method: 'DELETE' });
        try { await removeStoredImage(existing.image, user); }
        catch (error) { console.error('Deleted product image cleanup failed:', error.message); }
        return send(res, 200, { ok: true });
      } catch (error) {
        console.error('Hosted product delete failed:', error.message);
        return send(res, 500, { error: 'Could not remove the product.' });
      }
    }
  }

  return send(res, 404, { error: 'Not found' });
}

module.exports = { handleHostedRequest, IMAGE_PREFIX, productFromRow, productToRow };
