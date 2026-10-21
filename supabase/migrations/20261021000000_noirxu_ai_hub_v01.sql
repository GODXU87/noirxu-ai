-- NOIRXU AI V0.1 hub tables. This lives in NOIRXU AI's OWN Supabase project.
-- It stores only connection secrets (encrypted by the app), pending confirmations and an audit log.
-- It never stores copies of Ledger / Journal / RADAR records.

begin;

create table if not exists public.ai_credentials (
  user_id text not null,
  connection text not null check (connection in ('ledger', 'journal', 'radar', 'gmail')),
  metadata jsonb not null default '{}'::jsonb,
  sealed text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, connection)
);

create table if not exists public.ai_proposals (
  id uuid primary key,
  user_id text not null,
  tool text not null,
  status text not null check (status in ('pending', 'executing', 'succeeded', 'failed', 'outcome_unknown', 'rejected')),
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_proposals_user_created_idx on public.ai_proposals (user_id, created_at desc);

create table if not exists public.ai_audit_log (
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
create index if not exists ai_audit_log_user_at_idx on public.ai_audit_log (user_id, at desc);

-- Server-only: the browser never talks to this database.
alter table public.ai_credentials enable row level security;
alter table public.ai_proposals enable row level security;
alter table public.ai_audit_log enable row level security;
revoke all on table public.ai_credentials, public.ai_proposals, public.ai_audit_log from public, anon, authenticated;

commit;
