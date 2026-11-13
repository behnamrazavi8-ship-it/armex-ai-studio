-- LOKAL AI core schema reconstruction from the read-only Production catalog.
-- Schema only: this migration intentionally copies NO users, credits, messages,
-- payment orders, projects, images, storage objects, or other application data.
-- Reconstructed for a clean Supabase Staging database; do not apply to Production
-- until the existing migration-version drift has been reconciled separately.

-- Core application tables not covered by the two existing project/image migrations.
create table if not exists public.profiles (
  id uuid not null,
  username text,
  full_name text,
  credits integer not null default 20,
  created_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade,
  constraint profiles_username_key unique (username)
);

create table if not exists public.projects (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  project_type text,
  created_at timestamptz not null default now(),
  constraint projects_pkey primary key (id),
  constraint projects_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade
);

create table if not exists public.credit_transactions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  amount integer not null,
  transaction_type text not null,
  reference_key text not null,
  description text,
  created_at timestamptz not null default now(),
  constraint credit_transactions_pkey primary key (id),
  constraint credit_transactions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint credit_transactions_amount_check check (amount <> 0),
  constraint credit_transactions_transaction_type_check
    check (transaction_type = any (array['signup_bonus','referral_bonus','ad_reward','purchase','usage','refund','admin_adjustment']::text[])),
  constraint credit_transactions_reference_key_key unique (reference_key)
);

create table if not exists public.armex_conversations (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  title text not null default 'گفتگوی جدید',
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint armex_conversations_pkey primary key (id),
  constraint armex_conversations_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade
);

create table if not exists public.armex_messages (
  id uuid not null default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null,
  role text not null,
  content text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  constraint armex_messages_pkey primary key (id),
  constraint armex_messages_conversation_id_fkey foreign key (conversation_id) references public.armex_conversations(id) on delete cascade,
  constraint armex_messages_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_messages_role_check check (role = any (array['user','assistant','system']::text[]))
);

create table if not exists public.armex_payment_orders (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  amount numeric not null,
  currency text not null default 'IRR',
  credits bigint not null,
  provider text,
  provider_reference text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint armex_payment_orders_pkey primary key (id),
  constraint armex_payment_orders_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_payment_orders_amount_check check (amount > 0),
  constraint armex_payment_orders_credits_check check (credits > 0),
  constraint armex_payment_orders_status_check
    check (status = any (array['pending','paid','failed','cancelled','refunded']::text[]))
);

create table if not exists public.armex_referral_codes (
  user_id uuid not null,
  code text not null,
  created_at timestamptz not null default now(),
  constraint armex_referral_codes_pkey primary key (user_id),
  constraint armex_referral_codes_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_referral_codes_code_key unique (code)
);

create table if not exists public.armex_referrals (
  id uuid not null default gen_random_uuid(),
  referrer_user_id uuid not null,
  referred_user_id uuid not null,
  referral_code text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  qualified_at timestamptz,
  rewarded_at timestamptz,
  constraint armex_referrals_pkey primary key (id),
  constraint armex_referrals_referrer_user_id_fkey foreign key (referrer_user_id) references auth.users(id) on delete cascade,
  constraint armex_referrals_referred_user_id_fkey foreign key (referred_user_id) references auth.users(id) on delete cascade,
  constraint armex_referrals_referred_user_id_key unique (referred_user_id),
  constraint armex_referrals_check check (referrer_user_id <> referred_user_id),
  constraint armex_referrals_status_check
    check (status = any (array['pending','qualified','rewarded','rejected']::text[]))
);

create table if not exists public.armex_usage (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  actual_cost_usd numeric,
  credits_charged bigint not null default 0,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint armex_usage_pkey primary key (id),
  constraint armex_usage_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_usage_conversation_id_fkey foreign key (conversation_id) references public.armex_conversations(id) on delete set null,
  constraint armex_usage_request_id_key unique (request_id)
);

create table if not exists public.armex_wallets (
  user_id uuid not null,
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint armex_wallets_pkey primary key (user_id),
  constraint armex_wallets_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_wallets_balance_check check (balance >= 0)
);

create table if not exists public.armex_credit_transactions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  amount bigint not null,
  transaction_type text not null,
  idempotency_key text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint armex_credit_transactions_pkey primary key (id),
  constraint armex_credit_transactions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_credit_transactions_amount_check check (amount <> 0),
  constraint armex_credit_transactions_user_id_idempotency_key_key unique (user_id, idempotency_key)
);

-- Secondary indexes captured from Production (primary/unique indexes are
-- created by the table constraints above).
create index if not exists armex_conversations_user_date_idx
  on public.armex_conversations (user_id, updated_at desc);
create index if not exists armex_transactions_user_date_idx
  on public.armex_credit_transactions (user_id, created_at desc);
create index if not exists armex_messages_conversation_date_idx
  on public.armex_messages (conversation_id, created_at);
create index if not exists armex_messages_user_idx
  on public.armex_messages (user_id);
create index if not exists armex_orders_user_date_idx
  on public.armex_payment_orders (user_id, created_at desc);
create index if not exists armex_usage_user_date_idx
  on public.armex_usage (user_id, created_at desc);

-- All Production public tables have RLS enabled and not forced. These core
-- tables are enabled here; the two existing project/image migrations enable
-- RLS on their respective tables.
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.armex_conversations enable row level security;
alter table public.armex_messages enable row level security;
alter table public.armex_payment_orders enable row level security;
alter table public.armex_referral_codes enable row level security;
alter table public.armex_referrals enable row level security;
alter table public.armex_usage enable row level security;
alter table public.armex_wallets enable row level security;
alter table public.armex_credit_transactions enable row level security;

-- Row-level policies reproduced from the Production catalog.
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles
  for select to public using (auth.uid() = id);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update to public using (auth.uid() = id);

drop policy if exists "Users can create own projects" on public.projects;
create policy "Users can create own projects" on public.projects
  for insert to public with check (auth.uid() = user_id);
drop policy if exists "Users can delete own projects" on public.projects;
create policy "Users can delete own projects" on public.projects
  for delete to public using (auth.uid() = user_id);
drop policy if exists "Users can update own projects" on public.projects;
create policy "Users can update own projects" on public.projects
  for update to public using (auth.uid() = user_id);
drop policy if exists "Users can view own projects" on public.projects;
create policy "Users can view own projects" on public.projects
  for select to public using (auth.uid() = user_id);

drop policy if exists "Users can view own credit transactions" on public.credit_transactions;
create policy "Users can view own credit transactions" on public.credit_transactions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists armex_conversations_read_own on public.armex_conversations;
create policy armex_conversations_read_own on public.armex_conversations
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_transactions_read_own on public.armex_credit_transactions;
create policy armex_transactions_read_own on public.armex_credit_transactions
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_messages_read_own on public.armex_messages;
create policy armex_messages_read_own on public.armex_messages
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_orders_read_own on public.armex_payment_orders;
create policy armex_orders_read_own on public.armex_payment_orders
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_codes_read_own on public.armex_referral_codes;
create policy armex_codes_read_own on public.armex_referral_codes
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_referrals_read_own on public.armex_referrals;
create policy armex_referrals_read_own on public.armex_referrals
  for select to authenticated using (auth.uid() = referrer_user_id or auth.uid() = referred_user_id);
drop policy if exists armex_usage_read_own on public.armex_usage;
create policy armex_usage_read_own on public.armex_usage
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists armex_wallet_read_own on public.armex_wallets;
create policy armex_wallet_read_own on public.armex_wallets
  for select to authenticated using (auth.uid() = user_id);

-- Preserve Production table-level grants. Wallet writes are deliberately made
-- through SECURITY DEFINER RPCs, not direct service_role table writes.
grant references on table public.profiles to anon, authenticated;
grant select on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

grant references on table public.projects to anon, authenticated;
grant select, insert, delete on table public.projects to authenticated;
grant all on table public.projects to service_role;

grant select on table public.credit_transactions to authenticated;

grant select on table public.armex_conversations to authenticated;
grant all on table public.armex_conversations to service_role;

grant select on table public.armex_credit_transactions to authenticated, service_role;

grant select on table public.armex_messages to authenticated;
grant select, insert, delete on table public.armex_messages to service_role;

grant select on table public.armex_payment_orders to authenticated;

grant select on table public.armex_referral_codes to authenticated;
grant select on table public.armex_referrals to authenticated;

grant select on table public.armex_usage to authenticated;
grant select, insert on table public.armex_usage to service_role;

grant select on table public.armex_wallets to authenticated, service_role;

-- Production legacy credit path: retained for compatibility, but it is a
-- separate balance/ledger from armex_wallets and armex_credit_transactions.
create or replace function public.process_credit_transaction(
  p_user_id uuid,
  p_amount integer,
  p_transaction_type text,
  p_reference_key text,
  p_description text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_new_balance integer;
begin
  if p_user_id is null then
    raise exception 'Invalid user ID';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Invalid credit amount';
  end if;
  if p_reference_key is null
     or length(trim(p_reference_key)) = 0
     or length(p_reference_key) > 200 then
    raise exception 'Invalid reference key';
  end if;
  if p_transaction_type not in (
    'signup_bonus','referral_bonus','ad_reward','purchase',
    'usage','refund','admin_adjustment'
  ) then
    raise exception 'Invalid transaction type';
  end if;
  if p_transaction_type = 'signup_bonus' and p_amount <> 500 then
    raise exception 'Signup bonus must be 500 credits';
  end if;
  if p_transaction_type = 'referral_bonus' and p_amount <> 200 then
    raise exception 'Referral bonus must be 200 credits';
  end if;
  if p_transaction_type in (
    'signup_bonus','referral_bonus','ad_reward','purchase','refund'
  ) and p_amount < 0 then
    raise exception 'This transaction type must be positive';
  end if;
  if p_transaction_type = 'usage' and p_amount > 0 then
    raise exception 'Usage must be negative';
  end if;

  update public.profiles
    set credits = credits + p_amount
    where id = p_user_id and credits + p_amount >= 0
    returning credits into v_new_balance;
  if not found then
    raise exception 'User not found or insufficient credits';
  end if;

  insert into public.credit_transactions (
    user_id, amount, transaction_type, reference_key, description
  ) values (
    p_user_id, p_amount, p_transaction_type, trim(p_reference_key), p_description
  );
  return v_new_balance;
end;
$function$;

create or replace function public.armex_grant_credits(
  p_user_id uuid,
  p_amount bigint,
  p_type text,
  p_idempotency_key text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_user_id is null or p_amount <= 0 or nullif(p_idempotency_key, '') is null then
    raise exception 'Invalid credit grant parameters';
  end if;

  insert into public.armex_wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  perform 1 from public.armex_wallets where user_id = p_user_id for update;

  if exists (
    select 1 from public.armex_credit_transactions
    where user_id = p_user_id and idempotency_key = p_idempotency_key
  ) then
    return false;
  end if;

  update public.armex_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.armex_credit_transactions(
    user_id, amount, transaction_type, idempotency_key, description, metadata
  ) values (
    p_user_id, p_amount, p_type, p_idempotency_key, p_description,
    coalesce(p_metadata, '{}'::jsonb)
  );
  return true;
end;
$function$;

create or replace function public.armex_debit_credits(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_balance bigint;
begin
  if p_user_id is null or p_amount <= 0 or nullif(p_idempotency_key, '') is null then
    raise exception 'Invalid credit debit parameters';
  end if;

  insert into public.armex_wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.armex_wallets
  where user_id = p_user_id
  for update;

  if exists (
    select 1 from public.armex_credit_transactions
    where user_id = p_user_id and idempotency_key = p_idempotency_key
  ) then
    return true;
  end if;

  if v_balance < p_amount then
    return false;
  end if;

  update public.armex_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.armex_credit_transactions(
    user_id, amount, transaction_type, idempotency_key, description, metadata
  ) values (
    p_user_id, -p_amount, 'usage', p_idempotency_key, p_description,
    coalesce(p_metadata, '{}'::jsonb)
  );
  return true;
end;
$function$;

create or replace function public.armex_activate_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  r record;
begin
  perform public.armex_grant_credits(
    p_user_id, 500, 'signup_bonus',
    'signup_bonus:' || p_user_id::text,
    'اعتبار هدیه ثبت‌نام'
  );

  for r in
    select id, referrer_user_id
    from public.armex_referrals
    where referred_user_id = p_user_id and status = 'pending'
    for update
  loop
    update public.armex_referrals
    set status = 'qualified', qualified_at = now()
    where id = r.id;

    if public.armex_grant_credits(
      r.referrer_user_id, 200, 'referral_bonus',
      'referral_bonus:' || r.id::text,
      'پاداش دعوت موفق',
      jsonb_build_object('referral_id', r.id)
    ) then
      update public.armex_referrals
      set status = 'rewarded', rewarded_at = now()
      where id = r.id;
    end if;
  end loop;
end;
$function$;

create or replace function public.armex_auth_user_handler()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_code text;
  v_referrer uuid;
  v_new_code text;
  v_just_confirmed boolean := false;
begin
  insert into public.armex_wallets(user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  if not exists (
    select 1 from public.armex_referral_codes where user_id = new.id
  ) then
    loop
      v_new_code := upper(substr(
        replace(gen_random_uuid()::text, '-', ''), 1, 10
      ));
      exit when not exists (
        select 1 from public.armex_referral_codes where code = v_new_code
      );
    end loop;

    insert into public.armex_referral_codes(user_id, code)
    values (new.id, v_new_code)
    on conflict (user_id) do nothing;
  end if;

  if tg_op = 'INSERT' then
    v_code := upper(trim(coalesce(new.raw_user_meta_data->>'referral_code', '')));
    if v_code <> '' then
      select user_id into v_referrer
      from public.armex_referral_codes where code = v_code;

      if v_referrer is not null and v_referrer <> new.id then
        insert into public.armex_referrals(
          referrer_user_id, referred_user_id, referral_code
        ) values (v_referrer, new.id, v_code)
        on conflict (referred_user_id) do nothing;
      end if;
    end if;
    v_just_confirmed := new.email_confirmed_at is not null;
  else
    v_just_confirmed := old.email_confirmed_at is null
      and new.email_confirmed_at is not null;
  end if;

  if v_just_confirmed then
    perform public.armex_activate_user(new.id);
  end if;

  return new;
end;
$function$;

-- Legacy trigger retained exactly as observed. It grants into profiles.credits
-- and public.credit_transactions; it is not the new wallet ledger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (id, username, full_name, credits)
  values (new.id, null, null, 0);

  perform public.process_credit_transaction(
    new.id, 500, 'signup_bonus',
    'signup:' || new.id::text,
    'Welcome bonus - 500 credits'
  );
  return new;
end;
$function$;

-- Automatically enable RLS on future public tables, matching Production.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  cmd record;
  tbl name;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
    if cmd.schema_name is not null
       and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog','information_schema')
       and cmd.schema_name not like 'pg_toast%'
       and cmd.schema_name not like 'pg_temp%' then
      begin
        select c.relname into tbl
        from pg_catalog.pg_class c where c.oid = cmd.objid;
        execute format(
          'alter table if exists %I.%I enable row level security',
          cmd.schema_name, tbl
        );
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception when others then
        raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    else
      raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)',
        cmd.object_identity, cmd.schema_name;
    end if;
  end loop;
end;
$function$;

-- Function ACLs match the observed Production boundary.
revoke all on function public.process_credit_transaction(uuid,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.process_credit_transaction(uuid,integer,text,text,text) to service_role;

revoke all on function public.armex_grant_credits(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.armex_grant_credits(uuid,bigint,text,text,text,jsonb) to service_role;

revoke all on function public.armex_debit_credits(uuid,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.armex_debit_credits(uuid,bigint,text,text,jsonb) to service_role;

revoke all on function public.armex_activate_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.armex_auth_user_handler() from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;

-- Supabase Auth owns auth.users; only install the two application triggers.
drop trigger if exists armex_auth_user_handler_trigger on auth.users;
create trigger armex_auth_user_handler_trigger
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.armex_auth_user_handler();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The six other event triggers in Supabase are platform-managed. Only this
-- application event trigger is reconstructed here.
drop event trigger if exists ensure_rls;
create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
