-- Applied to the shared Loki project (pvvkuygggzvgspbstiwu) on 2026-10-21 as migration
-- `noirxu_ai_hub_v01_isolated`. New schema + new role only; no existing object is altered.
-- After applying, the owner sets the role password in the Supabase SQL editor:
--   alter role noirxu_ai_app password '<random password>';
create schema if not exists noirxu_ai;
revoke all on schema noirxu_ai from public, anon, authenticated;

create table if not exists noirxu_ai.credentials (
  user_id text not null,
  connection text not null check (connection in ('ledger', 'journal', 'radar', 'gmail')),
  metadata jsonb not null default '{}'::jsonb,
  sealed text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, connection)
);

create table if not exists noirxu_ai.proposals (
  id uuid primary key,
  user_id text not null,
  tool text not null,
  status text not null check (status in ('pending', 'executing', 'succeeded', 'failed', 'outcome_unknown', 'rejected')),
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_user_created_idx on noirxu_ai.proposals (user_id, created_at desc);

create table if not exists noirxu_ai.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  user_id text not null,
  tool text not null,
  kind text not null,
  event text not null,
  proposal_id uuid,
  record_id text,
  error_code text,
  duration_ms integer
);
create index if not exists audit_log_user_at_idx on noirxu_ai.audit_log (user_id, at desc);

alter table noirxu_ai.credentials enable row level security;
alter table noirxu_ai.proposals enable row level security;
alter table noirxu_ai.audit_log enable row level security;
revoke all on all tables in schema noirxu_ai from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'noirxu_ai_app') then
    create role noirxu_ai_app login noinherit nocreatedb nocreaterole noreplication connection limit 10;
  end if;
end $$;
alter role noirxu_ai_app set search_path = noirxu_ai;
grant usage on schema noirxu_ai to noirxu_ai_app;
grant select, insert, update, delete on noirxu_ai.credentials, noirxu_ai.proposals to noirxu_ai_app;
grant select, insert on noirxu_ai.audit_log to noirxu_ai_app;
create policy noirxu_ai_app_credentials on noirxu_ai.credentials for all to noirxu_ai_app using (true) with check (true);
create policy noirxu_ai_app_proposals on noirxu_ai.proposals for all to noirxu_ai_app using (true) with check (true);
create policy noirxu_ai_app_audit on noirxu_ai.audit_log for all to noirxu_ai_app using (true) with check (true);
