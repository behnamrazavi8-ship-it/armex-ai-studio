-- LOKAL AI private image generation history and storage
create table if not exists public.armex_image_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  prompt text not null check (char_length(prompt) between 1 and 6000),
  model text not null,
  aspect_ratio text not null,
  resolution text not null default '1K',
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  credits_charged bigint not null check (credits_charged > 0),
  actual_cost_usd numeric(12, 8),
  storage_path text,
  mime_type text,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint armex_image_generations_user_request_key unique (user_id, request_id),
  constraint armex_image_generations_storage_path_key unique (storage_path)
);

create index if not exists armex_image_generations_user_created_idx
  on public.armex_image_generations (user_id, created_at desc);

alter table public.armex_image_generations enable row level security;

drop policy if exists "Users can read their own generated images" on public.armex_image_generations;
create policy "Users can read their own generated images"
  on public.armex_image_generations for select to authenticated
  using ((select auth.uid()) = user_id);

grant select on table public.armex_image_generations to authenticated;
grant select, insert, update, delete on table public.armex_image_generations to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lokal-ai-images', 'lokal-ai-images', false, 20971520,
  array['image/png', 'image/jpeg', 'image/webp']::text[])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can view their own LOKAL AI images" on storage.objects;
create policy "Users can view their own LOKAL AI images"
  on storage.objects for select to authenticated
  using (bucket_id = 'lokal-ai-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text);
