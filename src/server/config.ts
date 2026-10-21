function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadConfig() {
  return {
    ownerPassword: env('NOIRXU_AI_OWNER_PASSWORD'),
    sessionSecret: env('NOIRXU_AI_SESSION_SECRET'),
    tokenEncryptionKey: env('NOIRXU_TOKEN_ENCRYPTION_KEY'),
    hubDatabase: env('NOIRXU_AI_SUPABASE_URL') && env('NOIRXU_AI_SUPABASE_SECRET_KEY')
      ? { url: env('NOIRXU_AI_SUPABASE_URL')!, key: env('NOIRXU_AI_SUPABASE_SECRET_KEY')! }
      : null,
    anthropicModel: env('NOIRXU_AI_MODEL') ?? 'claude-opus-5-5',
    ledger: {
      supabase: env('LEDGER_SUPABASE_URL') && env('LEDGER_SUPABASE_ANON_KEY') ? { url: env('LEDGER_SUPABASE_URL')!, anonKey: env('LEDGER_SUPABASE_ANON_KEY')! } : null,
      appUrl: env('LEDGER_APP_URL')
    },
    journal: {
      supabase: env('JOURNAL_SUPABASE_URL') && env('JOURNAL_SUPABASE_ANON_KEY') ? { url: env('JOURNAL_SUPABASE_URL')!, anonKey: env('JOURNAL_SUPABASE_ANON_KEY')! } : null,
      appUrl: env('JOURNAL_APP_URL')
    },
    radar: {
      apiUrl: env('RADAR_INTEGRATION_URL'),
      token: env('RADAR_INTEGRATION_TOKEN'),
      appUrl: env('RADAR_APP_URL') ?? env('RADAR_INTEGRATION_URL')
    },
    google: {
      clientId: env('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: env('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirectUri: env('GOOGLE_OAUTH_REDIRECT_URI')
    }
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
