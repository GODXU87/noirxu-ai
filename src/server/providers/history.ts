/** Which provider wrote a chat history: OpenAI Responses items carry a top-level `type`; Claude messages never do. */
export function historyProviderOf(history: unknown[]): 'anthropic' | 'openai' | null {
  if (!history.length) return null;
  return history.some(item => item && typeof item === 'object' && 'type' in item) ? 'openai' : 'anthropic';
}
