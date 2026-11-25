function getSupabaseConfig(requireServiceRole = false) {
  const rawUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !anonKey || (requireServiceRole && !serviceRoleKey)) {
    throw Error('Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY, and the required server-side key.');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Error('SUPABASE_URL must be a valid URL.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw Error('SUPABASE_URL must use HTTPS outside local development.');
  }
  return { url: url.origin, anonKey, serviceRoleKey };
}

async function supabaseRequest(path, { method = 'GET', token, serviceRole = false, body, headers = {} } = {}) {
  const config = getSupabaseConfig(serviceRole);
  const key = serviceRole ? config.serviceRoleKey : config.anonKey;
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: {
      apikey: key,
      ...(token || !path.startsWith('/auth/v1/') ? { Authorization: `Bearer ${token || key}` } : {}),
      ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }
  if (!response.ok) {
    const message = data && typeof data === 'object'
      ? data.message || data.msg || data.error_description || data.error
      : '';
    throw Object.assign(Error(message || `Supabase request failed (${response.status}).`), {
      status: response.status,
      details: data
    });
  }
  return { data, headers: response.headers };
}

function productFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    url: row.url,
    category: row.category,
    department: row.department,
    clothingType: row.clothing_type,
    price: row.price == null ? null : Number(row.price),
    targetPrice: row.target_price == null ? null : Number(row.target_price),
    notes: row.notes,
    image: row.image,
    tags: row.tags || [],
    added: Number(row.added),
    saved: Boolean(row.saved),
    priceHistory: row.price_history || [],
    lastCheckedAt: row.last_checked_at || null
  };
}

function productToRow(product, userId) {
  return {
    id: product.id,
    user_id: userId,
    name: product.name,
    brand: product.brand || '',
    url: product.url,
    category: product.category,
    department: product.department || '',
    clothing_type: product.clothingType || '',
    price: product.price ?? null,
    target_price: product.targetPrice ?? null,
    notes: product.notes || '',
    image: product.image || '',
    tags: Array.isArray(product.tags) ? product.tags : [],
    added: Number(product.added) || Date.now(),
    saved: Boolean(product.saved),
    price_history: Array.isArray(product.priceHistory) ? product.priceHistory : [],
    last_checked_at: product.lastCheckedAt || null
  };
}

module.exports = { getSupabaseConfig, supabaseRequest, productFromRow, productToRow };
