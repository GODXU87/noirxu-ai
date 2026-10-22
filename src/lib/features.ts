// Feature flags for the personal-assistant additions. Every flag is on unless listed in
// NOIRXU_AI_DISABLED_FEATURES (comma separated), so one feature can be switched off in
// Vercel without touching the rest of the app.

export const ASSISTANT_FEATURES = ['triage', 'commands', 'briefings', 'reply_drafts', 'water'] as const;
export type AssistantFeature = (typeof ASSISTANT_FEATURES)[number];
export type FeatureFlags = Record<AssistantFeature, boolean>;

export function loadFeatureFlags(raw: string | undefined = process.env.NOIRXU_AI_DISABLED_FEATURES): FeatureFlags {
  const disabled = new Set((raw ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
  return Object.fromEntries(ASSISTANT_FEATURES.map(feature => [feature, !disabled.has(feature)])) as FeatureFlags;
}
