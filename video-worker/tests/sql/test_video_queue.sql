-- Integration contract test for 20261114150000_lokal_video_queue.sql.
-- Runs only against the disposable PostgreSQL service in GitHub Actions.

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

insert into public.armex_wallets(user_id, balance) values
  ('11111111-1111-4111-8111-111111111111', 1000),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0);

do $test$
declare
  v_user uuid := '11111111-1111-4111-8111-111111111111';
  v_request_success uuid := '22222222-2222-4222-8222-222222222222';
  v_request_fail uuid := '33333333-3333-4333-8333-333333333333';
  v_request_uncertain uuid := '44444444-4444-4444-8444-444444444444';
  v_worker uuid := '55555555-5555-4555-8555-555555555555';
  v_second_worker uuid := '66666666-6666-4666-8666-666666666666';
  v_result jsonb;
  v_claim jsonb;
  v_job uuid;
  v_balance bigint;
begin
  if has_function_privilege('anon', 'public.lokal_claim_video_job(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.lokal_enqueue_video_generation(uuid, uuid, text, jsonb, bigint)', 'EXECUTE') then
    raise exception 'privileged Video RPC is executable by a public client role';
  end if;
  if not has_function_privilege('service_role', 'public.lokal_claim_video_job(uuid)', 'EXECUTE') then
    raise exception 'service_role cannot claim Video jobs';
  end if;
  if has_table_privilege('authenticated', 'public.lokal_video_jobs', 'SELECT') then
    raise exception 'authenticated role can read internal Video queue rows';
  end if;

  -- Enqueue is atomic with debit and idempotent on (user, request_id).
  v_result := public.lokal_enqueue_video_generation(
    v_user, v_request_success, 'test video prompt', '{"size":"1280*704"}'::jsonb, 25
  );
  if v_result->>'success' <> 'true' or v_result->>'duplicate' <> 'false' then
    raise exception 'first enqueue did not succeed: %', v_result;
  end if;
  v_job := (v_result->>'job_id')::uuid;

  v_result := public.lokal_enqueue_video_generation(
    v_user, v_request_success, 'test video prompt', '{"size":"1280*704"}'::jsonb, 25
  );
  if v_result->>'duplicate' <> 'true' or (v_result->>'job_id')::uuid <> v_job then
    raise exception 'duplicate enqueue was not idempotent: %', v_result;
  end if;

  select balance into v_balance from public.armex_wallets where user_id = v_user;
  if v_balance <> 975 then
    raise exception 'duplicate enqueue debited more than once; balance=%', v_balance;
  end if;

  -- One singleton lease prevents a second worker from claiming concurrently.
  v_claim := public.lokal_claim_video_job(v_worker);
  if (v_claim->>'job_id')::uuid <> v_job then
    raise exception 'worker did not claim the queued job: %', v_claim;
  end if;
  if public.lokal_claim_video_job(v_second_worker) is not null then
    raise exception 'second worker claimed while the global GPU lease was active';
  end if;
  if public.lokal_release_video_worker_lease(v_job, v_worker) then
    raise exception 'GPU lease released before job terminal state';
  end if;
  if not public.lokal_heartbeat_video_job(v_job, v_worker) then
    raise exception 'active job heartbeat failed';
  end if;

  -- Completion requires the deterministic object path and verified output.
  if public.lokal_complete_video_job(
    v_job, v_worker,
    v_user::text || '/' || v_request_success::text || '.mp4',
    2048, true
  ) is distinct from true then
    raise exception 'verified completion failed';
  end if;
  if not public.lokal_heartbeat_video_job(v_job, v_worker) then
    raise exception 'terminal job heartbeat failed while VM shutdown is pending';
  end if;
  if not public.lokal_release_video_worker_lease(v_job, v_worker) then
    raise exception 'GPU lease could not be released after terminal completion';
  end if;

  -- A confirmed terminal failure refunds exactly once; provider shutdown
  -- confirmation is still required before releasing the singleton lease.
  v_result := public.lokal_enqueue_video_generation(
    v_user, v_request_fail, 'known failing prompt', '{"size":"704*1280"}'::jsonb, 25
  );
  v_job := (v_result->>'job_id')::uuid;
  v_claim := public.lokal_claim_video_job(v_worker);
  if (v_claim->>'job_id')::uuid <> v_job then
    raise exception 'second job was not claimed';
  end if;
  v_result := public.lokal_fail_video_job(v_job, v_worker, 'known_terminal_failure', true);
  if v_result->>'refunded' <> 'true' or v_result->>'status' <> 'failed' then
    raise exception 'terminal failure was not refunded: %', v_result;
  end if;
  if not public.lokal_release_video_worker_lease(v_job, v_worker) then
    raise exception 'failed job lease could not be released after provider shutdown';
  end if;
  select balance into v_balance from public.armex_wallets where user_id = v_user;
  if v_balance <> 975 then
    raise exception 'terminal failure refund balance mismatch; balance=%', v_balance;
  end if;


  -- An uncertain failure is never refunded or automatically replayed.
  v_result := public.lokal_enqueue_video_generation(
    v_user, v_request_uncertain, 'uncertain prompt', '{"size":"1280*704"}'::jsonb, 25
  );
  v_job := (v_result->>'job_id')::uuid;
  v_claim := public.lokal_claim_video_job(v_worker);
  if (v_claim->>'job_id')::uuid <> v_job then
    raise exception 'uncertain job was not claimed';
  end if;
  v_result := public.lokal_fail_video_job(v_job, v_worker, 'network_outcome_unknown', false);
  if v_result->>'status' <> 'reconciliation_required' or v_result->>'refunded' <> 'false' then
    raise exception 'uncertain failure did not enter reconciliation: %', v_result;
  end if;
  if public.lokal_claim_video_job(v_second_worker) is not null then
    raise exception 'queue allowed a new job while reconciliation was required';
  end if;
  v_result := public.lokal_enqueue_video_generation(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '88888888-8888-4888-8888-888888888888',
    'reconciliation pause prompt', '{"size":"1280*704"}'::jsonb, 25
  );
  if v_result->>'success' <> 'false'
     or v_result->>'code' <> 'video_worker_reconciliation_required' then
    raise exception 'enqueue was not paused during GPU reconciliation: %', v_result;
  end if;
  select balance into v_balance from public.armex_wallets where user_id = v_user;
  if v_balance <> 950 then
    raise exception 'uncertain failure was unexpectedly refunded; balance=%', v_balance;
  end if;

  -- Insufficient balance must not create a billable job.
  v_result := public.lokal_enqueue_video_generation(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '77777777-7777-4777-8777-777777777777',
    'no credits prompt', '{"size":"1280*704"}'::jsonb, 25
  );
  if v_result->>'success' <> 'false' or v_result->>'code' <> 'insufficient_credits' then
    raise exception 'insufficient-credit enqueue was not rejected: %', v_result;
  end if;
end;
$test$;
