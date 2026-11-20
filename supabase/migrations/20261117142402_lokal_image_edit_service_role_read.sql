-- Keep image-edit job metadata readable by the server-side service role only.
-- RLS remains enabled and user-facing roles retain no table access.
grant select on table public.armex_image_edit_jobs to service_role;
grant select on table public.armex_image_edit_daily_usage to service_role;
