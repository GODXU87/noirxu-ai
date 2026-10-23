/**
 * Which provider wrote a chat history: OpenAI Responses items carry a top-level `type`;
 * Claude turns carry content blocks (arrays). Plain {role, content: string} messages, such as
 * locally answered turns, work with both, so a history made only of them is neutral (null).
 */
export function historyProviderOf(history: unknown[]): 'anthropic' | 'openai' | null {
  const items = history.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (items.some(item => 'type' in item)) return 'openai';
  if (items.some(item => Array.isArray(item.content))) return 'anthropic';
  return null;
}
