-- NOIRXU AI Phase C2: server-side conversation history and long-term memory.
--
-- Scope: creates three NEW tables in the noirxu_ai schema. No existing table, role,
-- schema, extension or other project (Ledger / Journal / RADAR) is modified.
-- Status: verified on an isolated PostgreSQL copy. NOT applied to Loki until approved.
--
-- Privacy:
--   messages.sealed       full message (incl. tool results) encrypted by the app (AES-256-GCM,
--                         key bound to the row), never readable as plain text in the database
--   messages.search_text  user/assistant text only, with e-mails, phone numbers and long digit
--                         runs masked by the app before insert; tool output is never searchable
--   memories.content      short user-approved preferences; the app rejects balances, holdings,
--                         prices, passwords, codes and card/ID numbers before insert
-- Retention: deleting sets deleted_at and purge_after = deleted_at + 30 days; rows are
--   removed by the app's scheduled purge after that. Nothing is purged before 30 days.

begin;

create table noirxu_ai.conversations (
  id uuid primary key,
  user_id text not null,
  title text not null default '新對話' check (char_length(title) between 1 and 120),
  source text not null default 'server' check (source in ('server', 'legacy_import', 'local_import')),
  -- Idempotent imports: the same browser conversation always maps to the same row.
  import_key text check (import_key is null or char_length(import_key) <= 120),
  -- Model context (history + notes) for continuing on another device, encrypted.
  context_sealed text,
  -- Optimistic concurrency for title and context.
  version integer not null default 1 check (version >= 1),
  message_count integer not null default 0 check (message_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  check ((deleted_at is null) = (purge_after is null))
);
create index conversations_user_recent_idx on noirxu_ai.conversations (user_id, updated_at desc) where deleted_at is null;
create unique index conversations_import_key_uq on noirxu_ai.conversations (user_id, import_key) where import_key is not null;
create index conversations_purge_idx on noirxu_ai.conversations (purge_after) where purge_after is not null;

create table noirxu_ai.messages (
  id uuid primary key,
  conversation_id uuid not null references noirxu_ai.conversations (id) on delete cascade,
  user_id text not null,
  -- Position in the conversation; two devices appending at once collide here and retry.
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('user', 'assistant', 'tool', 'notice', 'error', 'help')),
  sealed text not null,
  search_text text not null default '' check (char_length(search_text) <= 2000),
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create index messages_user_search_idx on noirxu_ai.messages (user_id, created_at desc);

create table noirxu_ai.memories (
  id uuid primary key,
  user_id text not null,
  category text not null check (category in ('preference', 'sasuke', 'brand', 'project', 'decision', 'routine')),
  content text not null check (char_length(content) between 1 and 500),
  source text not null check (source in ('user_command', 'chat', 'manual')),
  source_ref text check (source_ref is null or char_length(source_ref) <= 120),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  check ((deleted_at is null) = (purge_after is null))
);
create index memories_user_active_idx on noirxu_ai.memories (user_id, active, updated_at desc) where deleted_at is null;
create index memories_purge_idx on noirxu_ai.memories (purge_after) where purge_after is not null;

-- Least privilege for the app role (same pattern as the existing tables).
--   conversations: read, create, update (rename / soft delete / context), delete only for the
--                  30-day purge (messages follow by ON DELETE CASCADE)
--   messages:      read and append only — no update, no direct delete
--   memories:      read, create, update (edit / disable / soft delete), delete for the purge
grant select, insert, update, delete on noirxu_ai.conversations to noirxu_ai_app;
grant select, insert on noirxu_ai.messages to noirxu_ai_app;
grant select, insert, update, delete on noirxu_ai.memories to noirxu_ai_app;

alter table noirxu_ai.conversations enable row level security;
alter table noirxu_ai.messages enable row level security;
alter table noirxu_ai.memories enable row level security;
create policy noirxu_ai_app_conversations on noirxu_ai.conversations for all to noirxu_ai_app using (true) with check (true);
create policy noirxu_ai_app_messages on noirxu_ai.messages for all to noirxu_ai_app using (true) with check (true);
create policy noirxu_ai_app_memories on noirxu_ai.memories for all to noirxu_ai_app using (true) with check (true);

comment on table noirxu_ai.conversations is 'NOIRXU AI C2: conversation list; soft delete with 30-day purge';
comment on table noirxu_ai.messages is 'NOIRXU AI C2: encrypted messages, append-only for the app role';
comment on table noirxu_ai.memories is 'NOIRXU AI C2: user-approved long-term memory; no financial or market data';

commit;
