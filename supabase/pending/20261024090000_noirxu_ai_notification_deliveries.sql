-- PENDING — not applied. Needs the owner's approval before running on Loki.
-- Moves notification delivery state out of the settings key-value table (the interim
-- storage used by src/notify/delivery.ts) into dedicated, queryable tables.
-- Additive only: no existing table or row is changed or dropped.

create table if not exists noirxu_ai.notification_deliveries (
  dedupe_key    text primary key,
  user_id       text not null,
  kind          text not null,
  status        text not null check (status in ('pending','claimed','sending','provider_accepted','retry_pending','failed','expired')),
  attempts      integer not null default 0,
  message       jsonb not null,
  expires_at    timestamptz not null,
  lease_until   timestamptz,
  next_retry_at timestamptz,
  accepted_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists notification_deliveries_due on noirxu_ai.notification_deliveries (status, next_retry_at);

create table if not exists noirxu_ai.notification_attempts (
  id          bigserial primary key,
  dedupe_key  text not null references noirxu_ai.notification_deliveries (dedupe_key) on delete cascade,
  attempt     integer not null,
  device_id   text not null,
  platform    text not null,
  outcome     text not null,
  http_status integer,
  error       text,
  at          timestamptz not null default now()
);

create table if not exists noirxu_ai.inbox (
  dedupe_key text primary key,
  user_id    text not null,
  kind       text not null,
  title      text not null,
  body       text not null,
  url        text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists inbox_user_created on noirxu_ai.inbox (user_id, created_at desc);

alter table noirxu_ai.notification_deliveries enable row level security;
alter table noirxu_ai.notification_attempts enable row level security;
alter table noirxu_ai.inbox enable row level security;
create policy app_all on noirxu_ai.notification_deliveries for all to noirxu_ai_app using (true) with check (true);
create policy app_all on noirxu_ai.notification_attempts for all to noirxu_ai_app using (true) with check (true);
create policy app_all on noirxu_ai.inbox for all to noirxu_ai_app using (true) with check (true);

grant select, insert, update on noirxu_ai.notification_deliveries to noirxu_ai_app;
grant select, insert on noirxu_ai.notification_attempts to noirxu_ai_app;
grant usage on sequence noirxu_ai.notification_attempts_id_seq to noirxu_ai_app;
grant select, insert, update on noirxu_ai.inbox to noirxu_ai_app;
