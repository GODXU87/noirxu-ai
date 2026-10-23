-- Rollback for the pending notification tables: removes the app's access only.
-- The tables and their history are kept; drop them manually only after confirming they are unused.
revoke all on noirxu_ai.notification_deliveries from noirxu_ai_app;
revoke all on noirxu_ai.notification_attempts from noirxu_ai_app;
revoke all on noirxu_ai.inbox from noirxu_ai_app;
