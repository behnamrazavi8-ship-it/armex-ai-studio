-- LOKAL AI Video App: isolated, single-GPU durable queue.
-- This migration is intentionally committed to the feature branch only.
-- Do not apply to production until the Video API and worker deployment are reviewed.

create table if not exists public.lokal_video_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  prompt text not null check (char_length(btrim(prompt)) between 1 and 6000),
  model text not null check (model = 'wan2.2-ti2v-5b'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'interrupted')),
  credits_charged bigint not null check (credits_charged > 0),
  storage_path text unique,
  mime_type text,
  output_bytes bigint,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint lokal_video_generations_user_request_key unique (user_id, request_id),
  constraint lokal_video_generations_output_check check (
    (status <> 'completed') or
    (storage_path is not null and mime_type = 'video/mp4' and output_bytes between 1 and 52428800)
  )
);

create index if not exists lokal_video_generations_user_created_idx
  on public.lokal_video_generations (user_id, created_at desc);

create table if not exists public.lokal_video_jobs (
  job_id uuid primary key references public.lokal_video_generations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'interrupted')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1),
  max_attempts integer not null default 1 check (max_attempts = 1),
  available_at timestamptz not null default now(),
  locked_by uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lokal_video_jobs_processing_lease_check check (
    (status = 'processing' and locked_by is not null and lease_expires_at is not null)
    or status <> 'processing'
  )
);

create index if not exists lokal_video_jobs_queue_idx
  on public.lokal_video_jobs (status, available_at, created_at);

create table if not exists public.lokal_video_worker_lease (
  singleton_id smallint primary key check (singleton_id = 1),
  worker_id uuid,
  job_id uuid references public.lokal_video_jobs(job_id) on delete set null,
  state text not null default 'idle'
    check (state in ('idle', 'active', 'reconciliation_required')),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint lokal_video_worker_lease_invariant_check check (
    (state = 'idle' and worker_id is null and job_id is null and lease_expires_at is null)
    or
    (state in ('active', 'reconciliation_required') and worker_id is not null and job_id is not null and lease_expires_at is not null)
  )
);

insert into public.lokal_video_worker_lease(singleton_id, state)
values (1, 'idle')
on conflict (singleton_id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lokal-ai-videos', 'lokal-ai-videos', false, 52428800, array['video/mp4']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.lokal_video_generations enable row level security;
alter table public.lokal_video_jobs enable row level security;
alter table public.lokal_video_worker_lease enable row level security;

drop policy if exists "Users can read their own video generations" on public.lokal_video_generations;
create policy "Users can read their own video generations"
  on public.lokal_video_generations for select to authenticated
  using ((select auth.uid()) = user_id);

grant select on public.lokal_video_generations to authenticated;
grant all on public.lokal_video_generations to service_role;
grant all on public.lokal_video_jobs to service_role;
grant all on public.lokal_video_worker_lease to service_role;

create or replace function public.lokal_enqueue_video_generation(
  p_user_id uuid,
  p_request_id uuid,
  p_prompt text,
  p_settings jsonb,
  p_credits bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_prior public.lokal_video_generations%rowtype;
  v_debited boolean;
  v_job_id uuid;
  v_model constant text := 'wan2.2-ti2v-5b';
begin
  if p_user_id is null or p_request_id is null
     or nullif(btrim(p_prompt), '') is null
     or char_length(p_prompt) > 6000
     or p_settings is null or jsonb_typeof(p_settings) <> 'object'
     or p_credits is null or p_credits < 1 or p_credits > 100000 then
    raise exception 'Invalid video job parameters' using errcode = '22023';
  end if;

  insert into public.armex_wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  perform 1 from public.armex_wallets where user_id = p_user_id for update;

  select * into v_prior
  from public.lokal_video_generations
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    return jsonb_build_object(
      'success', true, 'duplicate', true,
      'job_id', v_prior.id, 'status', v_prior.status
    );
  end if;

  if exists (
    select 1 from public.lokal_video_worker_lease
    where singleton_id = 1 and state = 'reconciliation_required'
  ) then
    return jsonb_build_object('success', false, 'code', 'video_worker_reconciliation_required');
  end if;

  if exists (
    select 1 from public.armex_credit_transactions
    where user_id = p_user_id
      and idempotency_key = 'video_request:' || p_request_id::text
  ) then
    return jsonb_build_object('success', false, 'code', 'request_id_already_reserved');
  end if;

  v_debited := public.armex_debit_credits(
    p_user_id,
    p_credits,
    'video_request:' || p_request_id::text,
    'تولید ویدئو در LOKAL AI',
    jsonb_build_object('request_id', p_request_id, 'model', v_model, 'settings', p_settings)
  );

  if v_debited is distinct from true then
    return jsonb_build_object('success', false, 'code', 'insufficient_credits');
  end if;

  insert into public.lokal_video_generations (
    user_id, request_id, prompt, model, settings, credits_charged, status
  ) values (
    p_user_id, p_request_id, btrim(p_prompt), v_model, p_settings, p_credits, 'pending'
  ) returning id into v_job_id;

  insert into public.lokal_video_jobs(job_id, user_id, status)
  values (v_job_id, p_user_id, 'queued');

  return jsonb_build_object(
    'success', true, 'duplicate', false, 'job_id', v_job_id, 'status', 'pending'
  );
end;
$function$;

create or replace function public.lokal_claim_video_job(p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_lease public.lokal_video_worker_lease%rowtype;
  v_job public.lokal_video_jobs%rowtype;
begin
  if p_worker_id is null then
    raise exception 'Worker ID is required' using errcode = '22023';
  end if;

  select * into v_lease
  from public.lokal_video_worker_lease
  where singleton_id = 1
  for update;

  if v_lease.state = 'reconciliation_required' then
    return null;
  end if;

  if v_lease.state = 'active' then
    if v_lease.lease_expires_at <= now() then
      update public.lokal_video_worker_lease
        set state = 'reconciliation_required', updated_at = now()
        where singleton_id = 1;
      update public.lokal_video_jobs
        set status = 'interrupted', locked_by = null, lease_expires_at = null,
            last_error_code = 'worker_lease_expired', updated_at = now()
        where job_id = v_lease.job_id and status = 'processing';
      update public.lokal_video_generations
        set status = 'interrupted', error_code = 'worker_lease_expired'
        where id = v_lease.job_id and status = 'processing';
    end if;
    return null;
  end if;

  select * into v_job
  from public.lokal_video_jobs
  where status = 'queued' and available_at <= now()
  order by available_at, created_at
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.lokal_video_jobs
    set status = 'processing', attempt_count = attempt_count + 1,
        locked_by = p_worker_id, lease_expires_at = now() + interval '180 seconds',
        updated_at = now()
    where job_id = v_job.job_id;

  update public.lokal_video_generations
    set status = 'processing'
    where id = v_job.job_id;

  update public.lokal_video_worker_lease
    set worker_id = p_worker_id, job_id = v_job.job_id, state = 'active',
        lease_expires_at = now() + interval '180 seconds', updated_at = now()
    where singleton_id = 1;

  return (
    select jsonb_build_object(
      'job_id', g.id, 'user_id', g.user_id, 'request_id', g.request_id,
      'prompt', g.prompt, 'model', g.model, 'settings', g.settings,
      'credits_charged', g.credits_charged,
      'attempt_count', j.attempt_count, 'lease_expires_at', j.lease_expires_at
    )
    from public.lokal_video_generations g
    join public.lokal_video_jobs j on j.job_id = g.id
    where g.id = v_job.job_id
  );
end;
$function$;

create or replace function public.lokal_heartbeat_video_job(
  p_job_id uuid, p_worker_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_updated integer;
begin
  update public.lokal_video_jobs
    set lease_expires_at = now() + interval '180 seconds', updated_at = now()
    where job_id = p_job_id and status in ('processing', 'completed', 'failed')
      and locked_by = p_worker_id and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return false; end if;

  update public.lokal_video_worker_lease
    set lease_expires_at = now() + interval '180 seconds', updated_at = now()
    where singleton_id = 1 and state = 'active'
      and job_id = p_job_id and worker_id = p_worker_id
      and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Video worker lease is no longer owned' using errcode = '40001';
  end if;
  return true;
end;
$function$;

create or replace function public.lokal_complete_video_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_storage_path text,
  p_output_bytes bigint,
  p_output_verified boolean
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_user_id uuid;
  v_request_id uuid;
  v_updated integer;
begin
  if p_output_verified is distinct from true
     or p_output_bytes is null or p_output_bytes not between 1 and 52428800
     or p_storage_path is null then
    raise exception 'Verified video output is required' using errcode = '22023';
  end if;

  select g.user_id, g.request_id into v_user_id, v_request_id
  from public.lokal_video_generations g
  join public.lokal_video_jobs j on j.job_id = g.id
  join public.lokal_video_worker_lease l on l.job_id = j.job_id
  where g.id = p_job_id and j.status = 'processing'
    and j.locked_by = p_worker_id and j.lease_expires_at > now()
    and l.singleton_id = 1 and l.worker_id = p_worker_id
    and l.state = 'active' and l.lease_expires_at > now()
  for update of j, l;

  if not found then return false; end if;

  if p_storage_path <> v_user_id::text || '/' || v_request_id::text || '.mp4' then
    raise exception 'Video output path is not the assigned object path' using errcode = '22023';
  end if;

  update public.lokal_video_jobs
    set status = 'completed',
        last_error_code = null, updated_at = now()
    where job_id = p_job_id and status = 'processing' and locked_by = p_worker_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return false; end if;

  update public.lokal_video_generations
    set status = 'completed', storage_path = p_storage_path,
        mime_type = 'video/mp4', output_bytes = p_output_bytes,
        error_code = null, completed_at = now()
    where id = p_job_id and status = 'processing';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Video generation row could not be completed' using errcode = '40001';
  end if;

  -- Keep the singleton GPU lease until the control plane has stopped the VM
  -- and independently confirmed provider state.
  return true;
end;
$function$;

create or replace function public.lokal_fail_video_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_code text,
  p_terminal_confirmed boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_job record;
  v_updated integer;
begin
  select j.job_id, j.user_id, g.credits_charged
    into v_job
  from public.lokal_video_jobs j
  join public.lokal_video_generations g on g.id = j.job_id
  join public.lokal_video_worker_lease l on l.job_id = j.job_id
  where j.job_id = p_job_id and j.status = 'processing'
    and j.locked_by = p_worker_id and j.lease_expires_at > now()
    and l.singleton_id = 1 and l.worker_id = p_worker_id
    and l.state = 'active' and l.lease_expires_at > now()
  for update of j, l;

  if not found then
    return jsonb_build_object('accepted', false, 'code', 'lease_lost');
  end if;

  if p_terminal_confirmed is distinct from true then
    update public.lokal_video_jobs
      set status = 'interrupted', locked_by = null, lease_expires_at = null,
          last_error_code = left(coalesce(p_error_code, 'video_interrupted'), 80),
          updated_at = now()
      where job_id = p_job_id;
    update public.lokal_video_generations
      set status = 'interrupted',
          error_code = left(coalesce(p_error_code, 'video_interrupted'), 80)
      where id = p_job_id;
    update public.lokal_video_worker_lease
      set state = 'reconciliation_required', updated_at = now()
      where singleton_id = 1;
    return jsonb_build_object('accepted', true, 'status', 'reconciliation_required', 'refunded', false);
  end if;

  update public.lokal_video_jobs
    set status = 'failed',
        last_error_code = left(coalesce(p_error_code, 'video_worker_error'), 80),
        updated_at = now()
    where job_id = p_job_id;
  update public.lokal_video_generations
    set status = 'failed',
        error_code = left(coalesce(p_error_code, 'video_worker_error'), 80),
        completed_at = now()
    where id = p_job_id;

  perform public.armex_grant_credits(
    v_job.user_id, v_job.credits_charged, 'refund',
    'video_refund:' || v_job.job_id::text,
    'بازگشت اعتبار درخواست ویدئوی ناموفق',
    jsonb_build_object('job_id', v_job.job_id, 'reason', coalesce(p_error_code, 'video_worker_error'))
  );

  -- Keep the singleton GPU lease until the control plane has stopped the VM
  -- and independently confirmed provider state.
  return jsonb_build_object('accepted', true, 'status', 'failed', 'refunded', true);
end;
$function$;

create or replace function public.lokal_release_video_worker_lease(
  p_job_id uuid, p_worker_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_updated integer;
begin
  update public.lokal_video_worker_lease l
    set worker_id = null, job_id = null, state = 'idle',
        lease_expires_at = null, updated_at = now()
    where l.singleton_id = 1
      and l.state = 'active'
      and l.job_id = p_job_id
      and l.worker_id = p_worker_id
      and l.lease_expires_at > now()
      and exists (
        select 1 from public.lokal_video_jobs j
        where j.job_id = p_job_id and j.status in ('completed', 'failed')
      );
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return false; end if;

  update public.lokal_video_jobs
    set locked_by = null, lease_expires_at = null, updated_at = now()
    where job_id = p_job_id and status in ('completed', 'failed')
      and locked_by = p_worker_id;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Terminal Video job lease could not be released' using errcode = '40001';
  end if;
  return true;
end;
$function$;

create or replace function public.lokal_get_video_job_status(
  p_user_id uuid, p_request_id uuid
) returns jsonb
language sql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select case when g.id is null then null else jsonb_build_object(
    'job_id', g.id, 'request_id', g.request_id, 'status', g.status,
    'model', g.model, 'settings', g.settings, 'credits_charged', g.credits_charged,
    'storage_path', g.storage_path, 'mime_type', g.mime_type,
    'output_bytes', g.output_bytes, 'error_code', g.error_code,
    'created_at', g.created_at, 'completed_at', g.completed_at
  ) end
  from (select 1) seed
  left join public.lokal_video_generations g
    on g.user_id = p_user_id and g.request_id = p_request_id;
$function$;

revoke all on function public.lokal_enqueue_video_generation(uuid, uuid, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.lokal_claim_video_job(uuid) from public, anon, authenticated;
revoke all on function public.lokal_heartbeat_video_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.lokal_complete_video_job(uuid, uuid, text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.lokal_fail_video_job(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.lokal_release_video_worker_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.lokal_get_video_job_status(uuid, uuid) from public, anon, authenticated;

grant execute on function public.lokal_enqueue_video_generation(uuid, uuid, text, jsonb, bigint) to service_role;
grant execute on function public.lokal_claim_video_job(uuid) to service_role;
grant execute on function public.lokal_heartbeat_video_job(uuid, uuid) to service_role;
grant execute on function public.lokal_complete_video_job(uuid, uuid, text, bigint, boolean) to service_role;
grant execute on function public.lokal_fail_video_job(uuid, uuid, text, boolean) to service_role;
grant execute on function public.lokal_release_video_worker_lease(uuid, uuid) to service_role;
grant execute on function public.lokal_get_video_job_status(uuid, uuid) to service_role;
