-- PENDING — not applied. Needs the owner's approval before running on Loki.
-- Moves SASUKE background tasks out of the settings key-value table (the interim storage
-- used by src/tasks/service.ts: sealed `task:<id>` rows plus `tasks:index`) into dedicated
-- tables. Additive only: no existing table or row is changed or dropped. The app keeps
-- working on the settings table until the code is switched over in a separate change.
-- Task content (titles, step inputs) stays sealed by the app (`sealed` column), so the
-- database never holds it in plain text.

create table if not exists noirxu_ai.tasks (
  id          uuid primary key,
  user_id     text not null,
  kind        text not null check (kind in ('reminder','background','recurring','conditional')),
  status      text not null check (status in ('queued','running','waiting_approval','completed','failed','cancelled','outcome_unknown','paused')),
  next_at     timestamptz,
  lease_until timestamptz,
  claim       uuid,
  last_slot   timestamptz,
  sealed      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_due on noirxu_ai.tasks (status, next_at);
create index if not exists tasks_user on noirxu_ai.tasks (user_id, status);

create table if not exists noirxu_ai.task_runs (
  id          uuid primary key,
  task_id     uuid not null references noirxu_ai.tasks (id) on delete cascade,
  slot        timestamptz not null,
  status      text not null check (status in ('completed','failed','waiting_approval','outcome_unknown','skipped','not_met')),
  started_at  timestamptz not null,
  finished_at timestamptz,
  sealed      text not null,
  unique (task_id, slot)
);
create index if not exists task_runs_task on noirxu_ai.task_runs (task_id, started_at desc);

alter table noirxu_ai.tasks enable row level security;
alter table noirxu_ai.task_runs enable row level security;

-- Only the limited app role; no delete on runs (history is append-only, trimmed by a job later).
grant select, insert, update, delete on noirxu_ai.tasks to noirxu_ai_app;
grant select, insert, update on noirxu_ai.task_runs to noirxu_ai_app;
create policy tasks_app on noirxu_ai.tasks for all to noirxu_ai_app using (true) with check (true);
create policy task_runs_app on noirxu_ai.task_runs for all to noirxu_ai_app using (true) with check (true);
