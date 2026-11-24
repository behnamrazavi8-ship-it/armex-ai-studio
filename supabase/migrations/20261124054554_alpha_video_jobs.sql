-- DRAFT ONLY: reviewed schema for Alpha Wan 2.2 video jobs.
-- Do not apply directly to production. Convert to a timestamped migration with
-- the Supabase CLI, review against the live schema, then apply with explicit approval.

create table if not exists public.armex_video_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  conversation_id uuid not null references public.armex_conversations(id) on delete cascade,
  user_message_id uuid not null references public.armex_messages(id) on delete cascade,
  input_attachment_id uuid not null references public.armex_chat_attachments(id),
  input_storage_path text not null,
  prompt text not null check (char_length(prompt) between 1 and 1800),
  model text not null default 'video-wan22' check (model = 'video-wan22'),
  cinematic boolean not null default true,
  credits_reserved bigint not null check (credits_reserved > 0),
  alpha_generation_id text unique,
  alpha_cost_toman bigint,
  provider_status text,
  status text not null default 'queued' check (status in
    ('queued','submitting','processing','submission_unknown','completed','failed')),
  progress_percent integer check (progress_percent between 0 and 100),
  output_storage_path text,
  output_mime_type text,
  error_code text,
  locked_by uuid,
  lease_expires_at timestamptz,
  next_poll_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, request_id)
);

create index if not exists armex_video_generations_queue_idx
  on public.armex_video_generations(status, next_poll_at, created_at)
  where status in ('queued','processing');
create index if not exists armex_video_generations_user_history_idx
  on public.armex_video_generations(user_id, created_at desc);

alter table public.armex_video_generations enable row level security;
revoke all on public.armex_video_generations from anon, authenticated;
grant all on public.armex_video_generations to service_role;

create or replace function public.armex_create_video_job(
  p_user_id uuid, p_request_id uuid, p_conversation_id uuid,
  p_attachment_id uuid, p_prompt text, p_cinematic boolean, p_credits bigint
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, auth, pg_temp
as $function$
declare
  v_existing public.armex_video_generations%rowtype;
  v_attachment public.armex_chat_attachments%rowtype;
  v_debited boolean;
  v_message uuid;
  v_job public.armex_video_generations%rowtype;
begin
  if p_user_id is null or p_request_id is null or p_conversation_id is null
     or p_attachment_id is null or p_credits is null or p_credits <= 0
     or nullif(btrim(p_prompt), '') is null or char_length(p_prompt) > 1800 then
    raise exception 'Invalid video job parameters' using errcode='22023';
  end if;

  -- Serialize identical user/request pairs before checking idempotency.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_request_id::text, 0)
  );

  select * into v_existing from public.armex_video_generations
    where user_id=p_user_id and request_id=p_request_id;
  if found then
    return jsonb_build_object('success',true,'duplicate',true,'job_id',v_existing.id,
      'status',v_existing.status,'conversation_id',v_existing.conversation_id,
      'credits_reserved',v_existing.credits_reserved);
  end if;

  select * into v_attachment from public.armex_chat_attachments
    where id=p_attachment_id and user_id=p_user_id
      and conversation_id=p_conversation_id and status='ready'
      and mime_type in ('image/jpeg','image/png','image/webp');
  if not found then
    raise exception 'Verified image attachment for this conversation not found'
      using errcode='P0002';
  end if;

  perform 1 from public.armex_conversations
    where id=p_conversation_id and user_id=p_user_id;
  if not found then
    raise exception 'Conversation not found' using errcode='P0002';
  end if;

  -- Debit first. If it fails, no message or conversation-side mutation is made.
  -- Any later exception rolls this debit back with the surrounding transaction.
  v_debited := public.armex_debit_credits(
    p_user_id,p_credits,'alpha_video:'||p_request_id::text,
    'رزرو اعتبار برای ساخت ویدئو با Wan 2.2',
    jsonb_build_object('request_id',p_request_id,'model','video-wan22')
  );
  if not v_debited then
    return jsonb_build_object('success',false,'code','insufficient_credits');
  end if;

  insert into public.armex_messages(conversation_id,user_id,role,content,model,request_id)
    values(p_conversation_id,p_user_id,'user',btrim(p_prompt),'video-wan22',p_request_id)
    returning id into v_message;

  insert into public.armex_video_generations(
    user_id,request_id,conversation_id,user_message_id,input_attachment_id,
    input_storage_path,prompt,cinematic,credits_reserved
  ) values (
    p_user_id,p_request_id,p_conversation_id,v_message,p_attachment_id,
    v_attachment.storage_path,btrim(p_prompt),coalesce(p_cinematic,true),p_credits
  ) returning * into v_job;

  update public.armex_conversations set updated_at=now(),model='video-wan22'
    where id=p_conversation_id and user_id=p_user_id;

  return jsonb_build_object('success',true,'duplicate',false,'job_id',v_job.id,
    'status',v_job.status,'conversation_id',p_conversation_id,
    'credits_reserved',v_job.credits_reserved);
end;
$function$;

create or replace function public.armex_claim_video_job(p_worker_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_job public.armex_video_generations%rowtype;
begin
  if p_worker_id is null then raise exception 'Worker ID required' using errcode='22023'; end if;
  update public.armex_video_generations
    set status='submission_unknown',error_code='worker_lease_expired_during_submit',
        locked_by=null,lease_expires_at=null,updated_at=now()
    where status='submitting' and lease_expires_at <= now();
  select * into v_job from public.armex_video_generations
    where status in ('queued','processing')
      and next_poll_at <= now()
      and (lease_expires_at is null or lease_expires_at <= now())
    order by next_poll_at,created_at
    limit 1 for update skip locked;
  if not found then return null; end if;
  update public.armex_video_generations
    set status=case when status='queued' then 'submitting' else status end,
        locked_by=p_worker_id,lease_expires_at=now()+interval '180 seconds',
        updated_at=now()
    where id=v_job.id returning * into v_job;
  return jsonb_build_object(
    'id',v_job.id,'user_id',v_job.user_id,'conversation_id',v_job.conversation_id,
    'input_storage_path',v_job.input_storage_path,'prompt',v_job.prompt,
    'cinematic',v_job.cinematic,'status',v_job.status,
    'alpha_generation_id',v_job.alpha_generation_id,'expires_at',v_job.expires_at
  );
end;
$function$;

create or replace function public.armex_video_submission_result(
  p_job_id uuid,p_worker_id uuid,p_alpha_id text,p_cost_toman bigint
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_count integer;
begin
  if nullif(btrim(p_alpha_id), '') is null or char_length(p_alpha_id) > 200 then
    raise exception 'Invalid Alpha generation ID' using errcode='22023';
  end if;
  if p_cost_toman is not null and p_cost_toman < 0 then
    raise exception 'Invalid Alpha cost' using errcode='22023';
  end if;
  update public.armex_video_generations
    set status='processing',alpha_generation_id=p_alpha_id,
        alpha_cost_toman=greatest(coalesce(p_cost_toman,0),0),
        provider_status='processing',next_poll_at=now()+interval '4 seconds',
        locked_by=null,lease_expires_at=null,error_code=null,updated_at=now()
    where id=p_job_id and status='submitting' and locked_by=p_worker_id
      and alpha_generation_id is null;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$function$;

create or replace function public.armex_video_submission_unknown(
  p_job_id uuid,p_worker_id uuid
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_count integer;
begin
  update public.armex_video_generations
    set status='submission_unknown',error_code='provider_submission_unknown',
        locked_by=null,lease_expires_at=null,updated_at=now()
    where id=p_job_id and status='submitting' and locked_by=p_worker_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$function$;

create or replace function public.armex_video_update_progress(
  p_job_id uuid,p_worker_id uuid,p_status text,p_percent integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_count integer;
begin
  update public.armex_video_generations
    set provider_status=left(coalesce(p_status,'processing'),40),
        progress_percent=case when p_percent between 0 and 99 then p_percent else null end,
        next_poll_at=now()+interval '5 seconds',
        locked_by=null,lease_expires_at=null,updated_at=now()
    where id=p_job_id and status='processing' and locked_by=p_worker_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$function$;

create or replace function public.armex_finish_video_job(
  p_job_id uuid,p_worker_id uuid,p_storage_path text,p_size_bytes bigint,p_sha256 text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_job public.armex_video_generations%rowtype; v_message uuid; v_attachment uuid;
begin
  select * into v_job from public.armex_video_generations
    where id=p_job_id and status='processing' and locked_by=p_worker_id
    for update;
  if not found then return false; end if;
  if p_storage_path is null or p_size_bytes is null or p_sha256 is null
     or p_storage_path <> v_job.user_id::text||'/video/'||v_job.id::text||'.mp4'
     or p_size_bytes <= 0 or p_size_bytes > 52428800
     or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid video output metadata' using errcode='22023';
  end if;
  insert into public.armex_messages(conversation_id,user_id,role,content,model)
    values(v_job.conversation_id,v_job.user_id,'assistant',
      'ویدئوی شما با Wan 2.2 آماده شد.','video-wan22')
    returning id into v_message;
  v_attachment := gen_random_uuid();
  insert into public.armex_chat_attachments(
    id,user_id,conversation_id,message_id,storage_path,original_filename,
    mime_type,size_bytes,sha256,status,verified_at
  ) values (
    v_attachment,v_job.user_id,v_job.conversation_id,v_message,p_storage_path,
    'lokal-ai-wan22-video.mp4','video/mp4',p_size_bytes,p_sha256,'ready',now()
  );
  update public.armex_video_generations
    set status='completed',output_storage_path=p_storage_path,
        output_mime_type='video/mp4',progress_percent=100,completed_at=now(),
        locked_by=null,lease_expires_at=null,error_code=null,updated_at=now()
    where id=p_job_id;
  update public.armex_conversations set updated_at=now()
    where id=v_job.conversation_id and user_id=v_job.user_id;
  return true;
end;
$function$;

create or replace function public.armex_fail_video_job(
  p_job_id uuid,p_worker_id uuid,p_error_code text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare v_job public.armex_video_generations%rowtype;
begin
  if p_worker_id is null then
    raise exception 'Worker ID required' using errcode='22023';
  end if;
  select * into v_job from public.armex_video_generations
    where id=p_job_id and status in ('queued','submitting','processing')
      and locked_by=p_worker_id
    for update;
  if not found then return false; end if;
  update public.armex_video_generations
    set status='failed',error_code=left(coalesce(p_error_code,'provider_failed'),80),
        locked_by=null,lease_expires_at=null,completed_at=now(),updated_at=now()
    where id=p_job_id;
  perform public.armex_grant_credits(
    v_job.user_id,v_job.credits_reserved,'refund',
    'alpha_video_refund:'||v_job.id::text,
    'بازگشت اعتبار ساخت ویدئوی ناموفق',
    jsonb_build_object('job_id',v_job.id,'request_id',v_job.request_id,
      'provider','alpha','model','video-wan22')
  );
  return true;
end;
$function$;

revoke all on function public.armex_create_video_job(uuid,uuid,uuid,uuid,text,boolean,bigint) from public,anon,authenticated;
revoke all on function public.armex_claim_video_job(uuid) from public,anon,authenticated;
revoke all on function public.armex_video_submission_result(uuid,uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.armex_video_submission_unknown(uuid,uuid) from public,anon,authenticated;
revoke all on function public.armex_video_update_progress(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.armex_finish_video_job(uuid,uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.armex_fail_video_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.armex_create_video_job(uuid,uuid,uuid,uuid,text,boolean,bigint) to service_role;
grant execute on function public.armex_claim_video_job(uuid) to service_role;
grant execute on function public.armex_video_submission_result(uuid,uuid,text,bigint) to service_role;
grant execute on function public.armex_video_submission_unknown(uuid,uuid) to service_role;
grant execute on function public.armex_video_update_progress(uuid,uuid,text,integer) to service_role;
grant execute on function public.armex_finish_video_job(uuid,uuid,text,bigint,text) to service_role;
grant execute on function public.armex_fail_video_job(uuid,uuid,text) to service_role;
