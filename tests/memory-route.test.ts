import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAgendaStore } from '@/agenda/store';
import { MemoryStore } from '@/memory/store';
import { vault } from './helpers/chat-hub';
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ user: 'owner' as string | null, memories: null as any }));
vi.mock('@/server/session', () => ({ currentUser: async () => state.user }));
vi.mock('@/server/hub', () => ({ getHub: () => ({ memories: state.memories }) }));
const { GET, POST, PATCH, DELETE } = await import('@/app/api/memory/route');
const request = (method: string, body?: unknown, origin = 'http://local.test') => new Request('http://local.test/api/memory', { method, headers: { host: 'local.test', origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { state.user = 'owner'; state.memories = new MemoryStore(new MemoryAgendaStore(), vault); });

describe('memory correction route', () => {
  it('requires the viewed revision and a real correction, then returns a conflict for stale edit/delete', async () => {
    const created = await (await POST(request('POST', { content: '本地示範條目', category: 'other' }))).json();
    const { id } = created.memory;
    for (const body of [{ id, content: '新版內容' }, { id, revision: 1 }, { id, revision: 0, content: '新版內容' }, { id, revision: 1, content: '  ' }]) {
      expect((await PATCH(request('PATCH', body))).status).toBe(400);
    }
    expect((await DELETE(request('DELETE', { id }))).status).toBe(400);
    const changed = await PATCH(request('PATCH', { id, revision: 1, content: '更正後示範條目', category: 'decision' }));
    expect(changed.status).toBe(200); expect((await changed.json()).memory).toMatchObject({ revision: 2, category: 'decision', source: 'user' });
    expect((await PATCH(request('PATCH', { id, revision: 1, content: '過期更正' }))).status).toBe(409);
    expect((await DELETE(request('DELETE', { id, revision: 1 }))).status).toBe(409);
    expect((await (await GET(request('GET'))).json()).memories[0].content).toBe('更正後示範條目');
    expect((await DELETE(request('DELETE', { id, revision: 2 }))).status).toBe(200);
  });

  it('preserves session and same-origin enforcement and never permits another user to alter the entry', async () => {
    const created = await (await POST(request('POST', { content: '本地示範條目' }))).json(); const { id } = created.memory;
    expect((await PATCH(request('PATCH', { id, revision: 1, content: '不許寫入' }, 'https://outside.invalid'))).status).toBe(403);
    state.user = null;
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await PATCH(request('PATCH', { id, revision: 1, content: '不許寫入' }))).status).toBe(401);
    state.user = 'another';
    expect((await PATCH(request('PATCH', { id, revision: 1, content: '不許寫入' }))).status).toBe(404);
    state.user = 'owner'; expect((await (await GET(request('GET'))).json()).memories[0].content).toBe('本地示範條目');
  });
});
