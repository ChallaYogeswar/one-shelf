create table if not exists public.products (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 300),
  brand text not null default '',
  url text not null check (char_length(url) <= 4096),
  category text not null check (category in ('fashion', 'wearables', 'tech', 'home', 'beauty', 'accessories', 'other')),
  department text not null default '',
  clothing_type text not null default '',
  price numeric check (price is null or price >= 0),
  target_price numeric check (target_price is null or target_price >= 0),
  notes text not null default '',
  image text not null default '',
  tags text[] not null default '{}',
  added bigint not null,
  saved boolean not null default false,
  price_history jsonb not null default '[]'::jsonb check (jsonb_typeof(price_history) = 'array'),
  last_checked_at timestamptz
);

alter table public.products drop constraint if exists products_category_check;
alter table public.products
  add constraint products_category_check
  check (category in ('fashion', 'wearables', 'tech', 'home', 'beauty', 'accessories', 'other'));

create index if not exists products_user_added_idx
  on public.products (user_id, added desc);
create index if not exists products_last_checked_idx
  on public.products (last_checked_at nulls first);

alter table public.products enable row level security;
grant select, insert, update, delete on public.products to authenticated;

drop policy if exists "Users read their own products" on public.products;
create policy "Users read their own products"
  on public.products for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users insert their own products" on public.products;
create policy "Users insert their own products"
  on public.products for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own products" on public.products;
create policy "Users update their own products"
  on public.products for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own products" on public.products;
create policy "Users delete their own products"
  on public.products for delete to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_track_run timestamptz,
  created_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
grant select, insert, update on public.user_settings to authenticated;

drop policy if exists "Users read their own settings" on public.user_settings;
create policy "Users read their own settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users update their own settings" on public.user_settings;
create policy "Users update their own settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users insert their own settings" on public.user_settings;
create policy "Users insert their own settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create or replace function public.create_user_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_settings on auth.users;
create trigger on_auth_user_created_settings
  after insert on auth.users
  for each row execute procedure public.create_user_settings();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read their own product images" on storage.objects;
create policy "Users read their own product images"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users upload their own product images" on storage.objects;
create policy "Users upload their own product images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users update their own product images" on storage.objects;
create policy "Users update their own product images"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users delete their own product images" on storage.objects;
create policy "Users delete their own product images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
