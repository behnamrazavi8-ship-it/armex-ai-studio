-- Allow the authenticated Edge Function's privileged client to read edit jobs and quota.
-- Direct writes remain restricted to the SECURITY DEFINER queue RPCs.
grant select on table public.armex_image_edit_jobs to service_role;
grant select on table public.armex_image_edit_daily_usage to service_role;
