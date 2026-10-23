-- Rollback for C2 that keeps every row. Run only if C2 must be switched off.
-- 1) First turn the features off in the app (remove server_history / memory from
--    NOIRXU_AI_ENABLED_FEATURES) and redeploy, so nothing writes to these tables.
-- 2) Then take away the app role's access. The tables and their data stay intact and can
--    be re-enabled later by re-running the GRANT lines of the migration.
-- Dropping the tables is deliberately NOT part of this rollback; that would need a
-- separate, explicit approval after an export.

begin;
revoke all on noirxu_ai.conversations, noirxu_ai.messages, noirxu_ai.memories from noirxu_ai_app;
comment on table noirxu_ai.conversations is 'NOIRXU AI C2: disabled (access revoked); data retained';
comment on table noirxu_ai.messages is 'NOIRXU AI C2: disabled (access revoked); data retained';
comment on table noirxu_ai.memories is 'NOIRXU AI C2: disabled (access revoked); data retained';
commit;
