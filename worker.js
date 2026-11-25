const { checkSingleProduct } = require('./server');
const { getSupabaseConfig, supabaseRequest, productFromRow, productToRow } = require('./supabase-rest');

const INTERVAL_MS = Number(process.env.TRACK_INTERVAL_MS || 6 * 60 * 60 * 1000);
const CONCURRENCY = 4;
const PAGE_SIZE = 500;

async function loadProducts() {
  const products = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = `/rest/v1/products?select=*&order=user_id.asc,added.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    const { data } = await supabaseRequest(query, { serviceRole: true });
    if (!Array.isArray(data)) throw Error('Supabase returned an invalid product list.');
    products.push(...data);
    if (data.length < PAGE_SIZE) return products;
  }
}

async function saveProduct(product, userId) {
  const row = productToRow(product, userId);
  const query = `/rest/v1/products?id=eq.${encodeURIComponent(product.id)}&user_id=eq.${encodeURIComponent(userId)}`;
  await supabaseRequest(query, {
    method: 'PATCH',
    serviceRole: true,
    body: row,
    headers: { Prefer: 'return=minimal' }
  });
}

async function updateLastRun(userIds, lastTrackRun) {
  if (!userIds.length) return;
  const rows = [...new Set(userIds)].map(user_id => ({ user_id, last_track_run: lastTrackRun }));
  await supabaseRequest('/rest/v1/user_settings?on_conflict=user_id', {
    method: 'POST',
    serviceRole: true,
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
  });
}

async function runOnce() {
  getSupabaseConfig(true);
  const rows = await loadProducts();
  const cutoff = Date.now() - INTERVAL_MS;
  const due = rows.filter(row => !row.last_checked_at || new Date(row.last_checked_at).getTime() <= cutoff);
  const lastTrackRun = new Date().toISOString();
  let checked = 0;
  let failed = 0;
  let next = 0;

  async function processNext() {
    while (next < due.length) {
      const row = due[next++];
      const product = productFromRow(row);
      try {
        await checkSingleProduct(product);
        product.lastCheckedAt = new Date().toISOString();
        checked++;
      } catch (error) {
        failed++;
        product.lastCheckedAt = lastTrackRun;
        console.error(`Price check failed for product ${product.id}: ${error.message}`);
      }
      try { await saveProduct(product, row.user_id); }
      catch (error) {
        failed++;
        console.error(`Could not save price-check result for product ${product.id}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, processNext));
  await updateLastRun(rows.map(row => row.user_id), lastTrackRun);
  console.log(`Price-check run complete: checked ${checked}, failed ${failed}, skipped ${rows.length - due.length}.`);
  return { checked, failed, skipped: rows.length - due.length };
}

async function start() {
  if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 60_000) {
    throw Error('TRACK_INTERVAL_MS must be at least 60000.');
  }
  let stopping = false;
  let wakeWorker;
  const stop = () => {
    stopping = true;
    if (wakeWorker) wakeWorker();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    try { await runOnce(); }
    catch (error) { console.error('Price-check worker run failed:', error.message); }
    if (stopping) break;
    await new Promise(resolve => {
      const timer = setTimeout(finish, INTERVAL_MS);
      function finish() {
        clearTimeout(timer);
        wakeWorker = null;
        resolve();
      }
      wakeWorker = finish;
    });
  }
}

if (require.main === module) {
  start().catch(error => {
    console.error('Price-check worker could not start:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { runOnce, loadProducts };
