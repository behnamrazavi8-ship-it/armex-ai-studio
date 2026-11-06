-- Account-scoped project storage for LOKAL AI.
-- This is additive and intentionally separate from the existing legacy projects table.
create table if not exists public.lokal_user_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_id text not null,
  title text not null,
  prompt text not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lokal_user_projects_user_local_id_key unique (user_id, local_id)
);

create index if not exists lokal_user_projects_user_created_idx
  on public.lokal_user_projects (user_id, created_at desc);

alter table public.lokal_user_projects enable row level security;

drop policy if exists "Users can read their own LOKAL projects" on public.lokal_user_projects;
create policy "Users can read their own LOKAL projects"
  on public.lokal_user_projects for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own LOKAL projects" on public.lokal_user_projects;
create policy "Users can create their own LOKAL projects"
  on public.lokal_user_projects for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own LOKAL projects" on public.lokal_user_projects;
create policy "Users can update their own LOKAL projects"
  on public.lokal_user_projects for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own LOKAL projects" on public.lokal_user_projects;
create policy "Users can delete their own LOKAL projects"
  on public.lokal_user_projects for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.lokal_user_projects to authenticated;
