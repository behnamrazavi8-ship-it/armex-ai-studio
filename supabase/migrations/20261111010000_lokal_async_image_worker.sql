-- LOKAL AI asynchronous image jobs for the dedicated Medium worker.
-- This migration is committed to a feature branch only; it is not applied to Supabase.

alter table public.armex_image_generations
  drop constraint if exists armex_image_generations_status_check;

alter table public.armex_image_generations
  add constraint armex_image_generations_status_check
  check (status = any (array['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]));

create table if not exists public.armex_image_jobs (
  job_id uuid primary key references public.armex_image_generations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  locked_by uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and locked_by is not null and lease_expires_at is not null)
    or status <> 'processing'
  )
);

create index if not exists armex_image_jobs_claim_idx
  on public.armex_image_jobs (status, available_at, created_at);

create index if not exists armex_image_jobs_expired_lease_idx
  on public.armex_image_jobs (lease_expires_at)
  where status = 'processing';

alter table public.armex_image_jobs enable row level security;
revoke all on public.armex_image_jobs from public, anon, authenticated;

-- The Edge Function verifies the caller's JWT before invoking this service-role-only
-- function. Debit, generation row, and queue row are committed atomically.
create or replace function public.armex_enqueue_image_generation(
  p_user_id uuid,
  p_request_id uuid,
  p_prompt text,
  p_model text,
  p_aspect_ratio text,
  p_resolution text,
  p_credits bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_prior public.armex_image_generations%rowtype;
  v_debited boolean;
  v_job_id uuid;
begin
  if p_user_id is null or p_request_id is null
     or nullif(btrim(p_prompt), '') is null
     or char_length(p_prompt) > 2048
     or nullif(p_model, '') is null
     or p_credits is null or p_credits < 1 or p_credits > 1000 then
    raise exception 'Invalid image job parameters' using errcode = '22023';
  end if;

  perform 1 from public.armex_wallets where user_id = p_user_id for update;
  if not found then
    insert into public.armex_wallets(user_id) values (p_user_id)
    on conflict (user_id) do nothing;
    perform 1 from public.armex_wallets where user_id = p_user_id for update;
  end if;

  select * into v_prior
  from public.armex_image_generations
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    return jsonb_build_object(
      'success', true, 'duplicate', true, 'job_id', v_prior.id, 'status', v_prior.status
    );
  end if;

  if exists (
    select 1 from public.armex_credit_transactions
    where user_id = p_user_id and idempotency_key = 'image_request:' || p_request_id::text
  ) then
    return jsonb_build_object('success', false, 'code', 'request_id_already_reserved');
  end if;

  v_debited := public.armex_debit_credits(
    p_user_id,
    p_credits,
    'image_request:' || p_request_id::text,
    'تولید تصویر در LOKAL AI',
    jsonb_build_object(
      'request_id', p_request_id,
      'model', p_model,
      'aspect_ratio', p_aspect_ratio,
      'resolution', p_resolution
    )
  );

  if v_debited is distinct from true then
    return jsonb_build_object('success', false, 'code', 'insufficient_credits');
  end if;

  insert into public.armex_image_generations (
    user_id, request_id, prompt, model, aspect_ratio, resolution,
    credits_charged, status
  ) values (
    p_user_id, p_request_id, btrim(p_prompt), p_model, p_aspect_ratio, p_resolution,
    p_credits, 'pending'
  )
  returning id into v_job_id;

  insert into public.armex_image_jobs(job_id, user_id, status)
  values (v_job_id, p_user_id, 'queued');

  return jsonb_build_object(
    'success', true, 'duplicate', false, 'job_id', v_job_id, 'status', 'pending'
  );
end;
$function$;

-- A worker claims one job at a time. Expired leases are reclaimed; jobs that
-- exhausted their attempts are failed and refunded exactly once.
create or replace function public.armex_claim_image_job(p_worker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_expired record;
  v_job record;
begin
  if p_worker_id is null then
    raise exception 'Worker ID is required' using errcode = '22023';
  end if;

  for v_expired in
    select j.job_id, j.user_id, g.request_id, g.credits_charged
    from public.armex_image_jobs j
    join public.armex_image_generations g on g.id = j.job_id
    where j.status = 'processing'
      and j.lease_expires_at <= now()
      and j.attempt_count >= j.max_attempts
    for update of j skip locked
  loop
    update public.armex_image_jobs
      set status = 'failed', locked_by = null, lease_expires_at = null,
          last_error_code = 'worker_lease_exhausted', updated_at = now()
      where job_id = v_expired.job_id;

    update public.armex_image_generations
      set status = 'failed', error_code = 'worker_lease_exhausted',
          completed_at = now()
      where id = v_expired.job_id and status <> 'completed';

    perform public.armex_grant_credits(
      v_expired.user_id, v_expired.credits_charged, 'refund',
      'image_refund:' || v_expired.job_id::text,
      'بازگشت اعتبار درخواست تصویر ناموفق',
      jsonb_build_object('job_id', v_expired.job_id, 'request_id', v_expired.request_id, 'reason', 'worker_lease_exhausted')
    );
  end loop;

  select j.job_id, j.user_id, j.attempt_count, j.max_attempts
    into v_job
  from public.armex_image_jobs j
  where (
      (j.status = 'queued' and j.available_at <= now())
      or (j.status = 'processing' and j.lease_expires_at <= now() and j.attempt_count < j.max_attempts)
    )
  order by j.available_at, j.created_at
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.armex_image_jobs
    set status = 'processing',
        attempt_count = attempt_count + 1,
        locked_by = p_worker_id,
        lease_expires_at = now() + interval '180 seconds',
        updated_at = now()
    where job_id = v_job.job_id;

  update public.armex_image_generations
    set status = 'processing'
    where id = v_job.job_id;

  return (
    select jsonb_build_object(
      'job_id', g.id,
      'user_id', g.user_id,
      'request_id', g.request_id,
      'prompt', g.prompt,
      'model', g.model,
      'aspect_ratio', g.aspect_ratio,
      'resolution', g.resolution,
      'credits_charged', g.credits_charged,
      'attempt_count', j.attempt_count,
      'max_attempts', j.max_attempts,
      'lease_expires_at', j.lease_expires_at
    )
    from public.armex_image_generations g
    join public.armex_image_jobs j on j.job_id = g.id
    where g.id = v_job.job_id
  );
end;
$function$;

create or replace function public.armex_heartbeat_image_job(
  p_job_id uuid,
  p_worker_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_updated integer;
begin
  update public.armex_image_jobs
    set lease_expires_at = now() + interval '180 seconds', updated_at = now()
    where job_id = p_job_id and status = 'processing'
      and locked_by = p_worker_id and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

create or replace function public.armex_complete_image_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_storage_path text,
  p_mime_type text,
  p_actual_cost_usd numeric default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_updated integer;
begin
  if nullif(p_storage_path, '') is null
     or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Invalid image output metadata' using errcode = '22023';
  end if;

  update public.armex_image_jobs
    set status = 'completed', locked_by = null, lease_expires_at = null,
        last_error_code = null, updated_at = now()
    where job_id = p_job_id and status = 'processing'
      and locked_by = p_worker_id and lease_expires_at > now();
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then return false; end if;

  update public.armex_image_generations
    set status = 'completed', storage_path = p_storage_path,
        mime_type = p_mime_type, actual_cost_usd = p_actual_cost_usd,
        error_code = null, completed_at = now()
    where id = p_job_id and status = 'processing';

  return true;
end;
$function$;

create or replace function public.armex_fail_image_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_code text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_job record;
  v_next_status text;
  v_delay_seconds integer;
begin
  select j.job_id, j.user_id, j.attempt_count, j.max_attempts,
         g.request_id, g.credits_charged
    into v_job
  from public.armex_image_jobs j
  join public.armex_image_generations g on g.id = j.job_id
  where j.job_id = p_job_id and j.status = 'processing'
    and j.locked_by = p_worker_id and j.lease_expires_at > now()
  for update of j;

  if not found then
    return jsonb_build_object('accepted', false, 'code', 'lease_lost');
  end if;

  if coalesce(p_retryable, true) and v_job.attempt_count < v_job.max_attempts then
    v_delay_seconds := least(300, 5 * power(2, greatest(v_job.attempt_count - 1, 0))::integer);
    update public.armex_image_jobs
      set status = 'queued', available_at = now() + make_interval(secs => v_delay_seconds),
          locked_by = null, lease_expires_at = null,
          last_error_code = left(coalesce(p_error_code, 'worker_error'), 80),
          updated_at = now()
      where job_id = p_job_id;
    update public.armex_image_generations
      set status = 'pending', error_code = left(coalesce(p_error_code, 'worker_error'), 80)
      where id = p_job_id;
    return jsonb_build_object('accepted', true, 'status', 'queued', 'retry_after_seconds', v_delay_seconds);
  end if;

  update public.armex_image_jobs
    set status = 'failed', locked_by = null, lease_expires_at = null,
        last_error_code = left(coalesce(p_error_code, 'worker_error'), 80),
        updated_at = now()
    where job_id = p_job_id;

  update public.armex_image_generations
    set status = 'failed', error_code = left(coalesce(p_error_code, 'worker_error'), 80),
        completed_at = now()
    where id = p_job_id;

  perform public.armex_grant_credits(
    v_job.user_id, v_job.credits_charged, 'refund',
    'image_refund:' || v_job.job_id::text,
    'بازگشت اعتبار درخواست تصویر ناموفق',
    jsonb_build_object('job_id', v_job.job_id, 'request_id', v_job.request_id, 'reason', coalesce(p_error_code, 'worker_error'))
  );

  return jsonb_build_object('accepted', true, 'status', 'failed', 'refunded', true);
end;
$function$;

revoke all on function public.armex_enqueue_image_generation(uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.armex_claim_image_job(uuid) from public, anon, authenticated;
revoke all on function public.armex_heartbeat_image_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.armex_complete_image_job(uuid, uuid, text, text, numeric) from public, anon, authenticated;
revoke all on function public.armex_fail_image_job(uuid, uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.armex_enqueue_image_generation(uuid, uuid, text, text, text, text, bigint) to service_role;
grant execute on function public.armex_claim_image_job(uuid) to service_role;
grant execute on function public.armex_heartbeat_image_job(uuid, uuid) to service_role;
grant execute on function public.armex_complete_image_job(uuid, uuid, text, text, numeric) to service_role;
grant execute on function public.armex_fail_image_job(uuid, uuid, text, boolean) to service_role;
