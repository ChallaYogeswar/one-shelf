# ONE/SHELF

A private product shelf with clothing categories, price history, retailer metadata extraction, and local or hosted accounts.

## Local development

1. Install Node.js 20 or newer.
2. Run `npm install` once, then `npm start`.
3. Open <http://localhost:4317>.
4. Run `npm test` for the local API and account tests.

Without Supabase environment variables, the app uses the local JSON account and product files in `data/`. Keep that folder private and do not commit it.

## Hosted architecture

- **Vercel:** serves `index.html` and the API function in `api/[...path].js`.
- **Supabase:** email/password authentication, Postgres product storage with row-level security, and a private product-image bucket.
- **Render background worker:** checks due prices every six hours using Supabase's service-role key. The key is used only by the worker and must never be added to Vercel or browser code.

### Supabase setup

1. Create a Supabase project and enable email/password sign-in. Email confirmation is recommended.
2. From the project root, authenticate and link the CLI:

   ```powershell
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```

3. Review the migration status, then apply pending migrations:

   ```powershell
   npx supabase migration list --remote
   npx supabase db push --remote
   ```

   The initial migration creates the tables, RLS policies, signup trigger, and private image bucket on a new project. Never commit your Supabase access token or database password.
4. In Supabase Auth URL Configuration, set the production site URL and add your local/preview URLs to the redirect allow-list. Configure a production SMTP provider for confirmation and password-reset email delivery.
5. Save the project URL, anon/publishable key, and service-role/secret key. Never expose the service-role key.

The migrations in [`supabase/migrations/`](./supabase/migrations/) are the deployable schema history; [`supabase/schema.sql`](./supabase/schema.sql) is a convenient reference copy. Product and image rows are scoped by `auth.uid()`.

### Local hosted-mode test

Set the project URL and anon key in the same PowerShell window before starting the server:

```powershell
$env:SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co"
$env:SUPABASE_ANON_KEY = "YOUR_PUBLIC_ANON_KEY"
npm start
```

Hosted mode uses Supabase email/password auth through HttpOnly cookies, including email confirmation and password recovery. If Supabase requires email confirmation, the app asks the user to confirm before signing in. The local JSON account system remains available when the Supabase variables are unset.

### Deployment configuration

After the local hosted-mode test:

1. Deploy the project root to Vercel. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as Vercel server environment variables for Preview and Production. Do not set `SUPABASE_SERVICE_ROLE_KEY` on Vercel.
2. Create the Render background worker from [`render.yaml`](./render.yaml). Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the worker's secret environment. Add `KEEPA_API_KEY` or `RAINFOREST_API_KEY` only if you use those adapters.
3. Verify `https://YOUR_DOMAIN/api/health`, registration, email confirmation, sign-in, product CRUD, image upload, and background price checks before sharing the site.

Vercel API functions have a 30-second configured maximum; availability depends on the selected Vercel plan. The scheduled six-hour worker is separate so it can process a large shelf without relying on a serverless function timeout.

### Migrating the existing local shelf

1. Deploy or run the hosted app and create/confirm a Supabase account using the same email as the local account.
2. In PowerShell, set the Supabase URL, anon key, service-role key, and local account email, then run `npm run migrate:local`:

```powershell
$env:SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co"
$env:SUPABASE_ANON_KEY = "YOUR_PUBLIC_ANON_KEY"
$env:SUPABASE_SERVICE_ROLE_KEY = "YOUR_SERVER_ONLY_SECRET_KEY"
$env:LOCAL_EMAIL = "the-email-on-your-local-account@example.com"
npm run migrate:local
```

The migration copies the matching local account's products to the matching Supabase account. Remote image URLs are kept; embedded local image data is skipped. It does not copy local passwords or local authentication sessions. Back up `data/` before running it.

## Categories, importing, and prices

- Clothing groups: topwear, bottomwear, one-piece, footwear, underwear, and other clothing.
- Types include shirts, T-shirts, jeans, trousers/pants, and track pants.
- Accessories (such as wallets, belts, caps, sunglasses, and bags) have a separate top-level category.
- Use **Import list** to preview and categorize Markdown/text product links. The importer does not invent prices or images.
- Sort by recently added, name, or current price.
- Shopify product JSON and public HTML metadata are attempted for price checks. Retailers may block automated requests; verify prices before relying on them.

## Local data and authentication

Local mode stores account hashes in `data/accounts.json` and account products in `data/users/`. Passwords are salted scrypt hashes and local sessions are held in memory. This mode is for development on a trusted device, not public hosting.

Do not commit `data/`, `.env` files, API keys, or the Supabase service-role key.

## License

This project is licensed under the [MIT License](./LICENSE).
