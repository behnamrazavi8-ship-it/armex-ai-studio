-- Free, isolated image-to-image editing jobs with an atomic UTC daily quota.
-- This migration is branch-only until explicitly applied to Supabase.

create table if not exists public.armex_image_edit_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  prompt text not null check (char_length(prompt) between 1 and 1600),
  model text not null default '@cf/black-forest-labs/flux-2-klein-4b',
  input_storage_path text not null,
  output_storage_path text,
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 4),
  available_at timestamptz not null default now(),
  locked_by uuid,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(user_id, request_id),
  check ((status = 'processing' and locked_by is not null and lease_expires_at is not null)
    or status <> 'processing')
);

create index if not exists armex_image_edit_queue_idx
  on public.armex_image_edit_jobs(status, available_at, created_at);
create index if not exists armex_image_edit_user_idx
  on public.armex_image_edit_jobs(user_id, created_at desc);

create table if not exists public.armex_image_edit_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  edits_used integer not null default 0 check (edits_used between 0 and 5),
  updated_at timestamptz not null default now(),
  primary key(user_id, usage_date)
);

alter table public.armex_image_edit_jobs enable row level security;
alter table public.armex_image_edit_daily_usage enable row level security;
revoke all on public.armex_image_edit_jobs, public.armex_image_edit_daily_usage from public, anon, authenticated;

create or replace function public.armex_enqueue_image_edit(
  p_user_id uuid, p_request_id uuid, p_prompt text, p_input_storage_path text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_existing public.armex_image_edit_jobs%rowtype;
  v_today date := (now() at time zone 'UTC')::date;
  v_used integer;
  v_id uuid;
begin
  if p_user_id is null or p_request_id is null
     or nullif(btrim(p_prompt),'') is null or char_length(p_prompt) > 1600
     or p_input_storage_path is null
     or p_input_storage_path not like p_user_id::text || '/edit/%' then
    raise exception 'Invalid image edit request' using errcode='22023';
  end if;

  select * into v_existing from public.armex_image_edit_jobs
    where user_id=p_user_id and request_id=p_request_id;
  if found then
    return jsonb_build_object('success',true,'duplicate',true,'job_id',v_existing.id,'status',v_existing.status);
  end if;

  insert into public.armex_image_edit_daily_usage(user_id,usage_date,edits_used)
    values(p_user_id,v_today,0)
    on conflict(user_id,usage_date) do nothing;
  select edits_used into v_used from public.armex_image_edit_daily_usage
    where user_id=p_user_id and usage_date=v_today for update;
  if v_used >= 5 then
    return jsonb_build_object('success',false,'code','daily_quota_exceeded','limit',5,'used',v_used);
  end if;

  update public.armex_image_edit_daily_usage
    set edits_used=edits_used+1,updated_at=now()
    where user_id=p_user_id and usage_date=v_today
    returning edits_used into v_used;

  insert into public.armex_image_edit_jobs(user_id,request_id,prompt,input_storage_path)
    values(p_user_id,p_request_id,btrim(p_prompt),p_input_storage_path)
    returning id into v_id;

  return jsonb_build_object('success',true,'duplicate',false,'job_id',v_id,'status','queued','used',v_used,'limit',5);
end;
$function$;

create or replace function public.armex_claim_image_edit_job(p_worker_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_job public.armex_image_edit_jobs%rowtype;
begin
  if p_worker_id is null then raise exception 'Worker ID required' using errcode='22023'; end if;

  update public.armex_image_edit_jobs
    set status='failed',locked_by=null,lease_expires_at=null,error_code='worker_lease_exhausted',
        updated_at=now(),completed_at=now()
    where status='processing' and lease_expires_at <= now() and attempt_count >= max_attempts;

  select * into v_job from public.armex_image_edit_jobs
    where ((status='queued' and available_at<=now())
       or (status='processing' and lease_expires_at<=now() and attempt_count<max_attempts))
    order by available_at,created_at limit 1 for update skip locked;
  if not found then return null; end if;

  update public.armex_image_edit_jobs set status='processing',attempt_count=attempt_count+1,
    locked_by=p_worker_id,lease_expires_at=now()+interval '180 seconds',updated_at=now()
    where id=v_job.id returning * into v_job;

  return jsonb_build_object('job_id',v_job.id,'user_id',v_job.user_id,'request_id',v_job.request_id,
    'prompt',v_job.prompt,'model',v_job.model,'input_storage_path',v_job.input_storage_path,
    'attempt_count',v_job.attempt_count,'max_attempts',v_job.max_attempts);
end;
$function$;

create or replace function public.armex_heartbeat_image_edit_job(p_job_id uuid,p_worker_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_count integer;
begin
  update public.armex_image_edit_jobs set lease_expires_at=now()+interval '180 seconds',updated_at=now()
   where id=p_job_id and status='processing' and locked_by=p_worker_id and lease_expires_at>now();
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$function$;

create or replace function public.armex_complete_image_edit_job(
 p_job_id uuid,p_worker_id uuid,p_output_storage_path text
) returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_count integer; v_user uuid;
begin
  select user_id into v_user from public.armex_image_edit_jobs where id=p_job_id;
  if v_user is null or p_output_storage_path not like v_user::text || '/edit/%' then
    raise exception 'Invalid output path' using errcode='22023';
  end if;
  update public.armex_image_edit_jobs set status='completed',output_storage_path=p_output_storage_path,
    locked_by=null,lease_expires_at=null,error_code=null,completed_at=now(),updated_at=now()
    where id=p_job_id and status='processing' and locked_by=p_worker_id and lease_expires_at>now();
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$function$;

create or replace function public.armex_fail_image_edit_job(
 p_job_id uuid,p_worker_id uuid,p_error_code text,p_retryable boolean default true
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_job public.armex_image_edit_jobs%rowtype; v_delay integer;
begin
  select * into v_job from public.armex_image_edit_jobs
   where id=p_job_id and status='processing' and locked_by=p_worker_id and lease_expires_at>now()
   for update;
  if not found then return jsonb_build_object('accepted',false,'code','lease_lost'); end if;
  if coalesce(p_retryable,true) and v_job.attempt_count<v_job.max_attempts then
    v_delay:=least(120,5*power(2,greatest(v_job.attempt_count-1,0))::integer);
    update public.armex_image_edit_jobs set status='queued',available_at=now()+make_interval(secs=>v_delay),
      locked_by=null,lease_expires_at=null,error_code=left(coalesce(p_error_code,'worker_error'),80),updated_at=now()
      where id=p_job_id;
    return jsonb_build_object('accepted',true,'status','queued','retry_after_seconds',v_delay);
  end if;
  update public.armex_image_edit_jobs set status='failed',locked_by=null,lease_expires_at=null,
    error_code=left(coalesce(p_error_code,'worker_error'),80),completed_at=now(),updated_at=now()
    where id=p_job_id;
  return jsonb_build_object('accepted',true,'status','failed');
end;
$function$;

revoke all on function public.armex_enqueue_image_edit(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.armex_claim_image_edit_job(uuid) from public,anon,authenticated;
revoke all on function public.armex_heartbeat_image_edit_job(uuid,uuid) from public,anon,authenticated;
revoke all on function public.armex_complete_image_edit_job(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.armex_fail_image_edit_job(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.armex_enqueue_image_edit(uuid,uuid,text,text) to service_role;
grant execute on function public.armex_claim_image_edit_job(uuid) to service_role;
grant execute on function public.armex_heartbeat_image_edit_job(uuid,uuid) to service_role;
grant execute on function public.armex_complete_image_edit_job(uuid,uuid,text) to service_role;
grant execute on function public.armex_fail_image_edit_job(uuid,uuid,text,boolean) to service_role;
