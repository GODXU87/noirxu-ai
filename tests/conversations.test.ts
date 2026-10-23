import { beforeEach, describe, expect, it } from 'vitest';

class FakeStorage implements Storage {
  data = new Map<string, string>();
  quota = Infinity;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) {
    const used = [...this.data.entries()].filter(([key]) => key !== k).reduce((n, [key, val]) => n + key.length + val.length, 0);
    if (used + k.length + v.length > this.quota) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    this.data.set(k, v);
  }
}

const local = new FakeStorage();
const session = new FakeStorage();
Object.assign(globalThis, { localStorage: local, sessionStorage: session, window: new EventTarget() });
const lib = await import('@/app/sasuke/conversations');

const conv = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'assistant' : 'user', text: `訊息 ${i}` })), history: [], notes: [] });

beforeEach(() => { local.clear(); session.clear(); local.quota = Infinity; });

describe('C1: local conversations', () => {
  it('never deletes old conversations on its own, even far past the soft limit', () => {
    for (let i = 0; i < lib.SOFT_LIMIT + 15; i += 1) expect(lib.saveConversation(`c${i}`, conv(2), `第 ${i} 段`).ok).toBe(true);
    expect(lib.listConversations()).toHaveLength(lib.SOFT_LIMIT + 15);
    expect(lib.loadConversation('c0')).not.toBeNull();
  });

  it('reports a full storage instead of failing silently, and keeps what was already saved', () => {
    expect(lib.saveConversation('a', conv(2), 'first').ok).toBe(true);
    local.quota = [...local.data.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0) + 10;
    expect(lib.saveConversation('b', conv(50), 'too big')).toEqual({ ok: false, reason: 'quota' });
    expect(lib.loadConversation('a')?.items).toHaveLength(2);
    expect(lib.listConversations().map(c => c.id)).toEqual(['a']);
  });

  it('rename and delete report their result; delete removes only that conversation', () => {
    lib.saveConversation('a', conv(2), 'A'); lib.saveConversation('b', conv(2), 'B');
    expect(lib.renameConversation('a', '新名字').ok).toBe(true);
    expect(lib.listConversations().find(c => c.id === 'a')?.title).toBe('新名字');
    expect(lib.deleteConversation('b').ok).toBe(true);
    expect(lib.loadConversation('b')).toBeNull();
    expect(lib.loadConversation('a')).not.toBeNull();
  });
});

describe('C1: importing the classic chat', () => {
  it('imports once, verifies by reading back, and leaves the classic copy in place', () => {
    session.setItem('noirxu-ai-chat-v1', JSON.stringify(conv(4)));
    const first = lib.importLegacySession();
    expect(first).toMatchObject({ status: 'imported', items: 4 });
    expect(session.getItem('noirxu-ai-chat-v1')).not.toBeNull();
    expect(lib.importLegacySession()).toMatchObject({ status: 'unchanged' });
    expect(lib.listConversations()).toHaveLength(1);
    expect(lib.listConversations()[0]).toMatchObject({ imported: true });
  });

  it('when the classic chat grows, re-importing updates the same entry (no duplicates)', () => {
    session.setItem('noirxu-ai-chat-v1', JSON.stringify(conv(4)));
    const first = lib.importLegacySession() as { conversationId: string };
    session.setItem('noirxu-ai-chat-v1', JSON.stringify(conv(8)));
    const second = lib.importLegacySession();
    expect(second).toMatchObject({ status: 'updated', conversationId: first.conversationId, items: 8 });
    expect(lib.listConversations()).toHaveLength(1);
  });

  it('a failed import is not recorded and succeeds on retry', () => {
    session.setItem('noirxu-ai-chat-v1', JSON.stringify(conv(30)));
    local.quota = 50;
    expect(lib.importLegacySession()).toMatchObject({ status: 'failed' });
    expect(lib.legacyImports()).toHaveLength(0);
    local.quota = Infinity;
    expect(lib.importLegacySession()).toMatchObject({ status: 'imported', items: 30 });
    expect(lib.legacyImports()).toHaveLength(1);
  });

  it('switching UIs loses nothing: classic data stays in sessionStorage, SASUKE data in localStorage', () => {
    session.setItem('noirxu-ai-chat-v1', JSON.stringify(conv(2)));
    lib.importLegacySession();
    lib.saveConversation('new-one', conv(2), 'SASUKE only');
    // Classic reads only sessionStorage, which was never modified.
    expect(JSON.parse(session.getItem('noirxu-ai-chat-v1')!).items).toHaveLength(2);
    expect(lib.listConversations()).toHaveLength(2);
  });
});

describe('fresh conversation on each open', () => {
  it('continues the tab conversation only while it is recent and still saved', () => {
    const t0 = 1_800_000_000_000;
    expect(lib.resumeActive(t0)).toBeNull();
    lib.saveConversation('c1', conv(2), '問題');
    lib.touchActive('c1', t0);
    expect(lib.resumeActive(t0 + 5 * 60_000)).toBe('c1');
    expect(lib.resumeActive(t0 + lib.IDLE_MS)).toBeNull();
    // A new tab or relaunched app has empty sessionStorage: new conversation, old one kept.
    session.clear();
    expect(lib.resumeActive(t0)).toBeNull();
    expect(lib.listConversations().map(c => c.id)).toContain('c1');
  });
});
