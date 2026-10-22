import 'server-only';
import { getHub, HubConfigError } from './hub';

export type DatabaseHealth = 'ok' | 'not_configured' | 'wrong_role' | 'auth_failed' | 'missing_tables' | 'unreachable' | 'memory';

/** One real query against the hub schema, classified without exposing any detail. */
export async function databaseHealth(): Promise<DatabaseHealth> {
  if (!process.env.NOIRXU_AI_DATABASE_URL) return process.env.NODE_ENV === 'production' ? 'not_configured' : 'memory';
  try {
    const hub = getHub();
    await hub.agenda.getSetting('__health__');
    return 'ok';
  } catch (error) {
    if (error instanceof HubConfigError) return 'wrong_role';
    const code = (error as { code?: string }).code;
    if (code === '28P01' || code === '28000') return 'auth_failed';
    if (code === '42P01' || code === '3F000' || code === '42501') return 'missing_tables';
    return 'unreachable';
  }
}

/** Which integrations have their settings present (names only, never values). */
export function configuredFeatures() {
  const has = (...names: string[]) => names.every(name => Boolean(process.env[name]?.trim()));
  return {
    login: has('NOIRXU_AI_OWNER_PASSWORD', 'NOIRXU_AI_SESSION_SECRET'),
    encryption: has('NOIRXU_TOKEN_ENCRYPTION_KEY'),
    database: has('NOIRXU_AI_DATABASE_URL'),
    ai: has('ANTHROPIC_API_KEY'),
    ledger: has('LEDGER_SUPABASE_URL', 'LEDGER_SUPABASE_ANON_KEY'),
    journal: has('JOURNAL_SUPABASE_URL', 'JOURNAL_SUPABASE_ANON_KEY'),
    radar: has('RADAR_INTEGRATION_URL', 'RADAR_INTEGRATION_TOKEN'),
    gmail: has('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI')
  };
}
