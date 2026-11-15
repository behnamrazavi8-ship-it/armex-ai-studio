-- LOKAL AI private chat media attachments
-- The bucket is private. All uploads and downloads are mediated by armex-api
-- using short-lived signed upload/download URLs after ownership checks.

create table if not exists public.armex_chat_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.armex_conversations(id) on delete cascade,
  message_id uuid references public.armex_messages(id) on delete set null,
  storage_path text not null unique,
  original_filename text not null check (char_length(original_filename) between 1 and 180),
  mime_type text not null check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime'
  )),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  sha256 text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create index if not exists armex_chat_attachments_conversation_idx
  on public.armex_chat_attachments (user_id, conversation_id, created_at desc);

create index if not exists armex_chat_attachments_pending_idx
  on public.armex_chat_attachments (created_at)
  where status = 'pending';

alter table public.armex_chat_attachments enable row level security;

-- No direct table grants or user-facing policies: the authenticated API verifies
-- ownership and uses the server-side Supabase admin client for all metadata access.
revoke all on table public.armex_chat_attachments from anon, authenticated;
grant select, insert, update, delete on table public.armex_chat_attachments to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lokal-chat-media',
  'lokal-chat-media',
  false,
  52428800,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
