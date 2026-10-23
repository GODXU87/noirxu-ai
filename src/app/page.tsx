import { redirect } from 'next/navigation';
import { pageState } from '@/server/page-state';
import { currentUser } from '@/server/session';
import { loadFeatureFlags as getFeatures } from '@/lib/features';
import { Chat } from './Chat';
import { uiMode } from '@/server/ui-mode';
import { Frame } from './Frame';
import { loadConfig } from '@/server/config';

/** The model chat actually runs on, for the composer badge. Null when no API key is set. */
function aiLabel(): string | null {
  const config = loadConfig();
  if (config.aiProvider === 'openai') return config.openai.model.replace(/^gpt-/i, 'GPT-');
  if (config.aiProvider === 'anthropic') return config.anthropicModel.replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, n: string, a, b) => `Claude ${n[0].toUpperCase()}${n.slice(1)} ${a}.${b}`);
  return null;
}

export const dynamic = 'force-dynamic';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ c?: string; t?: string }> }) {
  const { c, t } = await searchParams;
  const userId = await currentUser();
  if (!userId) redirect('/login');
  const { connected, storageMode, problem } = await pageState(userId);
  const ui = await uiMode();
  return (
    <div className="shell chat-page">
      <Frame current="chat" />
      {problem && <p className="banner danger">{problem}</p>}
      {storageMode === 'memory' && <p className="banner">開發模式：資料只存在伺服器記憶體，重新啟動後會清空。</p>}
      <Chat key={`${c ?? 'home'}:${t ?? ''}`} connected={connected} features={getFeatures()} variant={ui} ai={aiLabel()} />
    </div>
  );
}
