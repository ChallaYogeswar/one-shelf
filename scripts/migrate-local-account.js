const fs = require('node:fs');
const path = require('node:path');
const { getSupabaseConfig, supabaseRequest, productToRow } = require('../supabase-rest');
const { normalizeProduct } = require('../server');

async function findHostedUser(email) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await supabaseRequest(`/auth/v1/admin/users?page=${page}&per_page=1000`, { serviceRole: true });
    const users = data?.users;
    if (!Array.isArray(users)) throw Error('Supabase returned an invalid user list.');
    const match = users.find(user => String(user.email || '').trim().toLowerCase() === email);
    if (match) return match;
    if (users.length < 1000) break;
  }
  return null;
}

async function migrate() {
  getSupabaseConfig(true);
  const email = String(process.env.LOCAL_EMAIL || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Error('Set LOCAL_EMAIL to the email address of the existing local account.');
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const accountFile = path.join(dataDir, 'accounts.json');
  if (!fs.existsSync(accountFile)) throw Error('The local accounts file was not found. Set DATA_DIR if needed.');
  const accountStore = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  const account = accountStore.users?.find(user => user.email === email);
  if (!account) throw Error('No matching local account was found.');
  const productsFile = path.join(dataDir, 'users', `${account.id}.json`);
  if (!fs.existsSync(productsFile)) throw Error('The local product shelf file was not found.');
  const localShelf = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
  if (!Array.isArray(localShelf.products)) throw Error('The local product shelf is invalid.');

  const hostedUser = await findHostedUser(email);
  if (!hostedUser) throw Error('Create and confirm the matching Supabase account before migrating this shelf.');

  let skippedInlineImages = 0;
  const rows = localShelf.products.map(product => {
    const normalized = normalizeProduct(product);
    if (typeof normalized.image === 'string' && normalized.image.startsWith('data:')) {
      normalized.image = '';
      skippedInlineImages++;
    }
    return productToRow(normalized, hostedUser.id);
  });
  for (let offset = 0; offset < rows.length; offset += 100) {
    await supabaseRequest('/rest/v1/products?on_conflict=id', {
      method: 'POST',
      serviceRole: true,
      body: rows.slice(offset, offset + 100),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }
  if (localShelf.lastTrackRun) {
    await supabaseRequest('/rest/v1/user_settings?on_conflict=user_id', {
      method: 'POST',
      serviceRole: true,
      body: { user_id: hostedUser.id, last_track_run: localShelf.lastTrackRun },
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }
  console.log(`Migrated ${rows.length} products. Skipped ${skippedInlineImages} embedded local images; remote image URLs were preserved.`);
}

migrate().catch(error => {
  console.error(`Local account migration failed: ${error.message}`);
  process.exitCode = 1;
});
