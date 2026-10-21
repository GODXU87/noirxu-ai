import { describe, expect, it, vi } from 'vitest';
import { CredentialStore, MemoryCredentialBackend } from '@/connections/credentials';
import { TokenVault } from '@/connections/vault';
import { Executor } from '@/hub/executor';
import { ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import { GMAIL_SCOPES, GmailService } from '@/tools/gmail/google';
import { buildRawMessage, encodeHeaderWord, extractBody } from '@/tools/gmail/mime';
import { gmailTools } from '@/tools/gmail/tools';

const KEY = Buffer.alloc(32, 7).toString('base64');
const config = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://ai.example.test/api/connections/gmail/callback' };

function decodeRaw(raw: string) {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('MIME', () => {
  it('encodes non-ASCII subjects and base64 bodies', () => {
    const raw = decodeRaw(buildRawMessage({ to: ['a@example.com'], cc: [], subject: '會議確認', body: '你好\n明天見' }));
    expect(raw).toContain(`Subject: ${encodeHeaderWord('會議確認')}`);
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('你好\r\n明天見');
  });

  it('rejects header injection', () => {
    expect(() => buildRawMessage({ to: ['a@example.com'], cc: [], subject: 'hi\r\nBcc: evil@example.com', body: 'x' })).toThrow();
  });

  it('prefers text/plain and strips HTML otherwise', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(extractBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('plain') } }, { mimeType: 'text/html', body: { data: b64('<b>html</b>') } }] })).toBe('plain');
    expect(extractBody({ mimeType: 'text/html', body: { data: b64('<p>Hi&amp;bye</p><script>x()</script>') } })).toBe('Hi&bye');
  });
});

function connectedService(scopes: string[], fetchImpl: typeof fetch) {
  const credentials = new CredentialStore(new MemoryCredentialBackend(), new TokenVault(KEY));
  void credentials.save('owner', 'gmail', { refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3600_000 }, { email: 'me@example.com', scopes, connectedAt: 'now' });
  return new GmailService(config, credentials, fetchImpl);
}

describe('Gmail OAuth', () => {
  it('requests read and send as separate incremental grants with PKCE', () => {
    const service = new GmailService(config, new CredentialStore(new MemoryCredentialBackend(), new TokenVault(KEY)));
    const read = new URL(service.beginAuthorization('read').url);
    const send = new URL(service.beginAuthorization('send').url);
    expect(read.searchParams.get('scope')).toContain(GMAIL_SCOPES.read);
    expect(read.searchParams.get('scope')).not.toContain(GMAIL_SCOPES.send);
    expect(send.searchParams.get('scope')).toContain(GMAIL_SCOPES.send);
    expect(send.searchParams.get('scope')).not.toContain(GMAIL_SCOPES.read);
    expect(read.searchParams.get('include_granted_scopes')).toBe('true');
    expect(read.searchParams.get('code_challenge_method')).toBe('S256');
    expect(read.searchParams.get('access_type')).toBe('offline');
  });

  it('is reported as not configured without client credentials', () => {
    const service = new GmailService({ clientId: null, clientSecret: null, redirectUri: null }, new CredentialStore(new MemoryCredentialBackend(), new TokenVault(KEY)));
    expect(service.configured).toBe(false);
    expect(() => service.beginAuthorization('read')).toThrow(/Google OAuth/);
  });

  it('disconnect revokes at Google and deletes local tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const service = connectedService([GMAIL_SCOPES.read], fetchImpl);
    await new Promise(resolve => setTimeout(resolve, 0));
    await service.disconnect('owner');
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('oauth2.googleapis.com/revoke');
    expect(await service.connection('owner')).toBeNull();
  });
});

describe('gmail.message.send', () => {
  function setup(scopes: string[]) {
    const sent: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/messages/send')) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const service = connectedService(scopes, fetchImpl);
    const registry = new ToolRegistry();
    gmailTools(service).forEach(tool => registry.register(tool));
    const executor = new Executor({ registry, store: new MemoryHubStore(), isConnected: async () => true });
    return { executor, sent, ctx: { userId: 'owner', now: () => new Date() } };
  }

  const draft = { to: ['friend@example.com'], subject: '週五聚餐', body: '週五晚上七點見，地點我再傳給你。' };

  it('shows recipient, subject and the full body, and sends only after confirmation', async () => {
    const { executor, sent, ctx } = setup([GMAIL_SCOPES.read, GMAIL_SCOPES.send]);
    const proposal = await executor.invoke('gmail.message.send', draft, ctx);
    if (proposal.status !== 'confirmation_required') throw new Error(JSON.stringify(proposal));
    expect(proposal.preview.fields).toContainEqual({ label: '收件人', value: 'friend@example.com' });
    expect(proposal.preview.fields).toContainEqual({ label: '主旨', value: '週五聚餐' });
    expect(proposal.preview.body).toBe(draft.body);
    expect(sent).toHaveLength(0);
    expect(await executor.confirm(proposal.proposalId, ctx)).toMatchObject({ status: 'succeeded', recordId: 'm1' });
    expect(sent).toHaveLength(1);
  });

  it('cannot send with only the read grant', async () => {
    const { executor, ctx } = setup([GMAIL_SCOPES.read]);
    expect(await executor.invoke('gmail.message.send', draft, ctx)).toMatchObject({ status: 'error', code: 'FORBIDDEN' });
  });

  it('rejects invalid recipients and multi-line subjects', async () => {
    const { executor, ctx } = setup([GMAIL_SCOPES.send]);
    expect(await executor.invoke('gmail.message.send', { ...draft, to: ['not-an-email'] }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await executor.invoke('gmail.message.send', { ...draft, subject: 'a\nBcc: x@example.com' }, ctx)).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
