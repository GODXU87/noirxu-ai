-- Rollback for 20261025090000_noirxu_ai_tasks.sql. Only drops the two new tables; the
-- settings-table task records (task:<id>, tasks:index) are untouched and keep working.
drop table if exists noirxu_ai.task_runs;
drop table if exists noirxu_ai.tasks;
