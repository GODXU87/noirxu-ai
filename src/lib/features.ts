// Feature flags for the personal-assistant additions.
// - Default-on features can be switched off with NOIRXU_AI_DISABLED_FEATURES.
// - Opt-in features (they need a database migration or cost money) stay off until listed
//   in NOIRXU_AI_ENABLED_FEATURES. Both are comma separated, so each can be toggled in
//   Vercel without touching the rest of the app.

export const ASSISTANT_FEATURES = ['triage', 'commands', 'briefings', 'reply_drafts', 'water'] as const;
export const OPT_IN_FEATURES = ['server_history', 'memory'] as const;
export type AssistantFeature = (typeof ASSISTANT_FEATURES)[number] | (typeof OPT_IN_FEATURES)[number];
export type FeatureFlags = Record<AssistantFeature, boolean>;

function set(raw: string | undefined) {
  return new Set((raw ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
}

export function loadFeatureFlags(
  disabledRaw: string | undefined = process.env.NOIRXU_AI_DISABLED_FEATURES,
  enabledRaw: string | undefined = process.env.NOIRXU_AI_ENABLED_FEATURES
): FeatureFlags {
  const disabled = set(disabledRaw);
  const enabled = set(enabledRaw);
  return Object.fromEntries([
    ...ASSISTANT_FEATURES.map(feature => [feature, !disabled.has(feature)]),
    ...OPT_IN_FEATURES.map(feature => [feature, enabled.has(feature) && !disabled.has(feature)])
  ]) as FeatureFlags;
}
