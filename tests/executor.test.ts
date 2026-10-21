import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError } from '@/hub/errors';
import { Executor } from '@/hub/executor';
import { defineTool, ToolRegistry } from '@/hub/registry';
import { MemoryHubStore } from '@/hub/store';
import type { ToolContext } from '@/hub/types';

const ctx = (userId = 'owner', now = new Date('2026-10-21T04:00:00Z')): ToolContext => ({ userId, now: () => now });

function setup(overrides: { run?: (...args: any[]) => any; reconcile?: (...args: any[]) => any; connected?: boolean } = {}) {
  const run = vi.fn(overrides.run ?? (async (input: { amount: number }, _ctx: ToolContext, meta: { idempotencyKey: string }) => ({
    data: { id: 'rec-1', amount: input.amount, key: meta.idempotencyKey }, recordId: 'rec-1', links: [{ label: 'src', url: 'https://example.test' }]
  })));
  const registry = new ToolRegistry()
    .register(defineTool({
      name: 'demo.read', description: '', connection: 'ledger', kind: 'read',
      input: z.object({ q: z.string() }).strict(), output: z.object({ echo: z.string() }),
      run: async input => ({ data: { echo: input.q } })
    }))
    .register(defineTool({
      name: 'demo.write', description: '', connection: 'ledger', kind: 'write',
      input: z.object({ amount: z.number().positive() }).strict(),
      output: z.object({ id: z.string(), amount: z.number(), key: z.string() }),
      preview: async input => ({ title: 'Write', fields: [{ label: 'amount', value: String(input.amount) }] }),
      run,
      reconcile: overrides.reconcile
    }));
  const store = new MemoryHubStore();
  const executor = new Executor({ registry, store, isConnected: async () => overrides.connected ?? true });
  return { executor, store, run };
}

describe('Executor', () => {
  it('runs read tools immediately and audits them', async () => {
    const { executor, store } = setup();
    expect(await executor.invoke('demo.read', { q: 'hi' }, ctx())).toEqual({ status: 'ok', tool: 'demo.read', data: { echo: 'hi' }, links: [] });
    expect(store.audit.map(entry => entry.event)).toEqual(['read']);
  });

  it('rejects invalid input without running anything', async () => {
    const { executor, run } = setup();
    const result = await executor.invoke('demo.write', { amount: -5 }, ctx());
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects extra fields (strict schemas)', async () => {
    const { executor } = setup();
    expect(await executor.invoke('demo.read', { q: 'x', extra: 1 }, ctx())).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });

  it('refuses tools whose connection is not set up', async () => {
    const { executor } = setup({ connected: false });
    expect(await executor.invoke('demo.read', { q: 'x' }, ctx())).toMatchObject({ status: 'error', code: 'NOT_CONNECTED' });
  });

  it('unknown tools fail closed', async () => {
    const { executor } = setup();
    expect(await executor.invoke('nope', {}, ctx())).toMatchObject({ status: 'error', code: 'UNKNOWN_TOOL' });
  });

  it('write tools only create a proposal; nothing runs until confirmed', async () => {
    const { executor, run } = setup();
    const result = await executor.invoke('demo.write', { amount: 150 }, ctx());
    expect(result.status).toBe('confirmation_required');
    expect(run).not.toHaveBeenCalled();
    if (result.status !== 'confirmation_required') throw new Error('unreachable');
    expect(result.preview.fields).toEqual([{ label: 'amount', value: '150' }]);

    const confirmed = await executor.confirm(result.proposalId, ctx());
    expect(confirmed).toMatchObject({ status: 'succeeded', recordId: 'rec-1' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('confirming twice runs once and returns the stored result with the same idempotency key', async () => {
    const { executor, run } = setup();
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    const first = await executor.confirm(proposal.proposalId, ctx());
    const second = await executor.confirm(proposal.proposalId, ctx());
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('concurrent confirmations execute exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { executor, run } = setup({ run: async () => { await gate; return { data: { id: 'r', amount: 1, key: 'k' } }; } });
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    const a = executor.confirm(proposal.proposalId, ctx());
    const b = executor.confirm(proposal.proposalId, ctx()).catch((error: ToolError) => error.code);
    release();
    await a;
    expect(await b).toBe('PROPOSAL_NOT_PENDING');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('another user cannot confirm or reject a proposal', async () => {
    const { executor, run } = setup();
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx('owner'));
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    await expect(executor.confirm(proposal.proposalId, ctx('intruder'))).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' });
    await expect(executor.reject(proposal.proposalId, ctx('intruder'))).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' });
    expect(run).not.toHaveBeenCalled();
  });

  it('expired proposals are not executed', async () => {
    const { executor, run } = setup();
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    await expect(executor.confirm(proposal.proposalId, ctx('owner', new Date('2026-10-21T05:00:00Z')))).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejected proposals cannot be confirmed afterwards', async () => {
    const { executor, run } = setup();
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    await executor.reject(proposal.proposalId, ctx());
    await expect(executor.confirm(proposal.proposalId, ctx())).rejects.toMatchObject({ code: 'PROPOSAL_NOT_PENDING' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a source-system rejection is reported as failed, never as success', async () => {
    const { executor, store } = setup({ run: async () => { throw new ToolError('UPSTREAM_REJECTED', 'INVALID_TRANSACTION_CATEGORY'); } });
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    expect(await executor.confirm(proposal.proposalId, ctx())).toMatchObject({ status: 'failed', code: 'UPSTREAM_REJECTED' });
    expect((await store.getProposal(proposal.proposalId))?.status).toBe('failed');
  });

  it('an unknown outcome triggers reconciliation instead of a blind retry', async () => {
    const reconcile = vi.fn(async () => ({ candidates: [{ id: 'maybe' }] }));
    const { executor, run } = setup({ run: async () => { throw new ToolError('OUTCOME_UNKNOWN', 'timeout'); }, reconcile });
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    const result = await executor.confirm(proposal.proposalId, ctx());
    expect(result).toMatchObject({ status: 'outcome_unknown', candidates: [{ id: 'maybe' }] });
    // Re-confirming does not re-send.
    await executor.confirm(proposal.proposalId, ctx());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('unexpected internal errors do not leak details', async () => {
    const { executor } = setup({ run: async () => { throw new Error('secret token abc'); } });
    const proposal = await executor.invoke('demo.write', { amount: 1 }, ctx());
    if (proposal.status !== 'confirmation_required') throw new Error('unreachable');
    const result = await executor.confirm(proposal.proposalId, ctx());
    expect(result).toMatchObject({ status: 'failed', code: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
