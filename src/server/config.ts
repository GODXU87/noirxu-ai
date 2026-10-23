function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export type AiProvider = 'anthropic' | 'openai';

export function pickProvider(): AiProvider | null {
  const chosen = env('NOIRXU_AI_PROVIDER');
  const has = { anthropic: Boolean(env('ANTHROPIC_API_KEY')), openai: Boolean(env('OPENAI_API_KEY')) };
  if (chosen === 'anthropic' || chosen === 'openai') return has[chosen] ? chosen : null;
  return has.anthropic ? 'anthropic' : has.openai ? 'openai' : null;
}

export function loadConfig() {
  return {
    ownerPassword: env('NOIRXU_AI_OWNER_PASSWORD'),
    sessionSecret: env('NOIRXU_AI_SESSION_SECRET'),
    tokenEncryptionKey: env('NOIRXU_TOKEN_ENCRYPTION_KEY'),
    /** Postgres URL that logs in as the limited `noirxu_ai_app` role (see supabase/migrations). */
    hubDatabaseUrl: env('NOIRXU_AI_DATABASE_URL'),
    anthropicModel: env('NOIRXU_AI_MODEL') ?? 'claude-opus-5-5',
    /** Which AI provider runs chat: NOIRXU_AI_PROVIDER, else whichever API key is set (Claude first). */
    aiProvider: pickProvider(),
    openai: {
      model: env('OPENAI_MODEL') ?? 'gpt-5.5',
      reasoningEffort: (['low', 'medium', 'high'] as const).find(v => v === env('OPENAI_REASONING_EFFORT')) ?? null
    },
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
