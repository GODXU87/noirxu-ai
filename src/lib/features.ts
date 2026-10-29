// Feature flags for the personal-assistant additions. Default-on features can be switched
// off with NOIRXU_AI_DISABLED_FEATURES; opt-in features (new integrations that touch
// personal data or send proactive notifications) stay off until listed in
// NOIRXU_AI_ENABLED_FEATURES. Both are comma separated, so one feature can be changed in
// Vercel without touching the rest of the app.

export const ASSISTANT_FEATURES = ['triage', 'commands', 'briefings', 'reply_drafts', 'water', 'tasks', 'voice', 'quality', 'hud'] as const;
export const OPT_IN_FEATURES = ['finance_alerts', 'garmin', 'weather', 'us_markets'] as const;
export type AssistantFeature = (typeof ASSISTANT_FEATURES)[number] | (typeof OPT_IN_FEATURES)[number];
export type FeatureFlags = Record<AssistantFeature, boolean>;

function list(raw: string | undefined) {
  return new Set((raw ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
}

export function loadFeatureFlags(raw: string | undefined = process.env.NOIRXU_AI_DISABLED_FEATURES, enabledRaw: string | undefined = process.env.NOIRXU_AI_ENABLED_FEATURES): FeatureFlags {
  const disabled = list(raw);
  const enabled = list(enabledRaw);
  return {
    ...Object.fromEntries(ASSISTANT_FEATURES.map(feature => [feature, !disabled.has(feature)])),
    ...Object.fromEntries(OPT_IN_FEATURES.map(feature => [feature, enabled.has(feature) && !disabled.has(feature)]))
  } as FeatureFlags;
}
