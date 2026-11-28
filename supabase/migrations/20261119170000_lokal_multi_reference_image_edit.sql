-- Add up to three independently stored reference images to one chat image-edit job.
-- Branch-only until the user explicitly approves the production migration and Worker rollout.

alter table public.armex_image_edit_jobs
  add column if not exists input_storage_paths text[] not null default '{}';

update public.armex_image_edit_jobs
set input_storage_paths = array[input_storage_path]
where coalesce(cardinality(input_storage_paths), 0) = 0;

create or replace function public.armex_enqueue_image_edit_multi(
  p_user_id uuid,
  p_request_id uuid,
  p_prompt text,
  p_input_storage_paths text[]
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_result jsonb;
  v_job_id uuid;
  v_path text;
begin
  if p_input_storage_paths is null
     or cardinality(p_input_storage_paths) < 1
     or cardinality(p_input_storage_paths) > 3 then
    raise exception 'One to three input images are required' using errcode='22023';
  end if;

  foreach v_path in array p_input_storage_paths loop
    if v_path is null or v_path not like p_user_id::text || '/edit/%' then
      raise exception 'Invalid image edit input path' using errcode='22023';
    end if;
  end loop;

  -- The existing enqueue function owns the daily quota lock and idempotency
  -- check. Updating the array inside this same transaction prevents a Worker
  -- from claiming the job before all reference paths are committed.
  v_result := public.armex_enqueue_image_edit(
    p_user_id, p_request_id, p_prompt, p_input_storage_paths[1]
  );

  if v_result->>'success' = 'true'
     and coalesce((v_result->>'duplicate')::boolean, false) = false then
    v_job_id := (v_result->>'job_id')::uuid;
    update public.armex_image_edit_jobs
      set input_storage_paths = p_input_storage_paths
      where id = v_job_id and user_id = p_user_id;
  end if;

  return v_result;
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

  return jsonb_build_object(
    'job_id',v_job.id,
    'user_id',v_job.user_id,
    'request_id',v_job.request_id,
    'prompt',v_job.prompt,
    'model',v_job.model,
    'input_storage_path',v_job.input_storage_path,
    'input_storage_paths',case
      when coalesce(cardinality(v_job.input_storage_paths),0)>0 then to_jsonb(v_job.input_storage_paths)
      else jsonb_build_array(v_job.input_storage_path)
    end,
    'attempt_count',v_job.attempt_count,
    'max_attempts',v_job.max_attempts
  );
end;
$function$;

revoke all on function public.armex_enqueue_image_edit_multi(uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.armex_enqueue_image_edit_multi(uuid,uuid,text,text[]) to service_role;
