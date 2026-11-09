-- Minimal Supabase Auth surface for the isolated core-baseline test.
-- No production identities or application data are copied.
create extension if not exists pgcrypto;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;

create schema if not exists auth;
create table auth.users (
  id uuid primary key,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $function$
  select null::uuid
$function$;

-- Minimal Storage catalog surface required by the existing image migration.
create schema if not exists storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(p_name text)
returns text[]
language sql
immutable
as $function$
  select string_to_array(p_name, '/')
$function$;
