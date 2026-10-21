import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolError, toToolError } from './errors';
import type { ToolRegistry } from './registry';
import type { HubStore } from './store';
import type { ConfirmResult, InvokeResult, Proposal, ToolContext, ToolDefinition } from './types';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export interface ExecutorOptions {
  registry: ToolRegistry;
  store: HubStore;
  /** Which connections the user has set up; tools on other connections fail with NOT_CONNECTED. */
  isConnected: (userId: string, connection: ToolDefinition['connection']) => Promise<boolean>;
}

function issuesMessage(error: z.ZodError): string {
  return error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export class Executor {
  constructor(private readonly options: ExecutorOptions) {}

  private resolve(name: string): ToolDefinition {
    const tool = this.options.registry.get(name);
    if (!tool) throw new ToolError('UNKNOWN_TOOL', `沒有這個工具：${name}`);
    return tool;
  }

  private parseInput(tool: ToolDefinition, raw: unknown) {
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) throw new ToolError('INVALID_INPUT', issuesMessage(parsed.error), { tool: tool.name });
    return parsed.data;
  }

  private async requireConnection(tool: ToolDefinition, ctx: ToolContext) {
    if (!(await this.options.isConnected(ctx.userId, tool.connection))) {
      throw new ToolError('NOT_CONNECTED', `尚未連接 ${tool.connection}，請先到 Connections 頁面設定。`);
    }
  }

  /** Read tools run immediately. Write/send tools only create a proposal that the user must confirm. */
  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<InvokeResult> {
    const started = Date.now();
    let tool: ToolDefinition | undefined;
    try {
      tool = this.resolve(name);
      const input = this.parseInput(tool, rawInput);
      await this.requireConnection(tool, ctx);

      if (tool.kind === 'read') {
        const result = await tool.run(input, ctx, { idempotencyKey: randomUUID(), startedAt: ctx.now() });
        const output = tool.output.safeParse(result.data);
        if (!output.success) throw new ToolError('INVALID_OUTPUT', '來源系統回傳的資料格式不符，已停止處理。');
        await this.options.store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'read', durationMs: Date.now() - started });
        return { status: 'ok', tool: tool.name, data: output.data, links: result.links ?? [] };
      }

      const preview = await tool.preview!(input, ctx);
      const now = ctx.now();
      const proposal: Proposal = {
        id: randomUUID(),
        userId: ctx.userId,
        tool: tool.name,
        input,
        preview,
        idempotencyKey: randomUUID(),
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString()
      };
      await this.options.store.createProposal(proposal);
      await this.options.store.appendAudit({ at: proposal.createdAt, userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'proposed', proposalId: proposal.id });
      return { status: 'confirmation_required', tool: tool.name, proposalId: proposal.id, preview, expiresAt: proposal.expiresAt };
    } catch (error) {
      const failure = toToolError(error);
      if (tool) {
        await this.options.store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'failed', errorCode: failure.code, durationMs: Date.now() - started });
      }
      return { status: 'error', tool: name, code: failure.code, message: failure.message };
    }
  }

  /** Runs a confirmed proposal exactly once. Confirming an already-finished proposal returns its stored outcome. */
  async confirm(proposalId: string, ctx: ToolContext): Promise<ConfirmResult> {
    const store = this.options.store;
    const existing = await store.getProposal(proposalId);
    if (!existing || existing.userId !== ctx.userId) throw new ToolError('PROPOSAL_NOT_FOUND', '找不到這個待確認的操作。');

    if (existing.status === 'succeeded') {
      return { status: 'succeeded', tool: existing.tool, proposalId, data: existing.result, recordId: existing.recordId, links: existing.links ?? [] };
    }
    if (existing.status === 'failed' || existing.status === 'outcome_unknown') {
      return { status: existing.status, tool: existing.tool, proposalId, code: existing.error!.code, message: existing.error!.message, candidates: (existing.result as { candidates?: unknown[] })?.candidates, links: existing.links ?? [] };
    }
    if (existing.status !== 'pending') throw new ToolError('PROPOSAL_NOT_PENDING', '這個操作已在處理中或已取消。');
    if (Date.parse(existing.expiresAt) <= ctx.now().getTime()) {
      await store.transitionProposal(proposalId, 'pending', 'rejected', { finishedAt: ctx.now().toISOString(), error: { code: 'PROPOSAL_EXPIRED', message: '確認逾時，操作未執行。' } });
      throw new ToolError('PROPOSAL_EXPIRED', '確認逾時，操作未執行，請重新提出。');
    }

    const tool = this.resolve(existing.tool);
    const startedAt = ctx.now();
    const claimed = await store.transitionProposal(proposalId, 'pending', 'executing', { startedAt: startedAt.toISOString() });
    if (!claimed) throw new ToolError('PROPOSAL_NOT_PENDING', '這個操作已在處理中。');
    await store.appendAudit({ at: startedAt.toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'confirmed', proposalId });

    const meta = { idempotencyKey: claimed.idempotencyKey, startedAt };
    try {
      const input = this.parseInput(tool, claimed.input);
      await this.requireConnection(tool, ctx);
      const result = await tool.run(input, ctx, meta);
      const output = tool.output.safeParse(result.data);
      if (!output.success) {
        // The source system accepted the write but answered in an unexpected shape.
        throw new ToolError('OUTCOME_UNKNOWN', '來源系統已回應，但回應格式不符，請到原網站確認是否已建立。');
      }
      const links = result.links ?? [];
      await store.transitionProposal(proposalId, 'executing', 'succeeded', { finishedAt: ctx.now().toISOString(), result: output.data, recordId: result.recordId, links });
      await store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'succeeded', proposalId, recordId: result.recordId, durationMs: ctx.now().getTime() - startedAt.getTime() });
      return { status: 'succeeded', tool: tool.name, proposalId, data: output.data, recordId: result.recordId, links };
    } catch (error) {
      const failure = toToolError(error);
      if (failure.code === 'OUTCOME_UNKNOWN') {
        let candidates: unknown[] | undefined;
        let links = [] as ConfirmResult['links'];
        if (tool.reconcile) {
          try {
            const found = await tool.reconcile(this.parseInput(tool, claimed.input), ctx, meta);
            candidates = found.candidates;
            links = found.links ?? [];
          } catch {
            candidates = undefined;
          }
        }
        await store.transitionProposal(proposalId, 'executing', 'outcome_unknown', { finishedAt: ctx.now().toISOString(), error: { code: failure.code, message: failure.message }, result: { candidates }, links });
        await store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'outcome_unknown', proposalId, errorCode: failure.code });
        return { status: 'outcome_unknown', tool: tool.name, proposalId, code: failure.code, message: failure.message, candidates, links };
      }
      await store.transitionProposal(proposalId, 'executing', 'failed', { finishedAt: ctx.now().toISOString(), error: { code: failure.code, message: failure.message } });
      await store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: tool.name, kind: tool.kind, event: 'failed', proposalId, errorCode: failure.code });
      return { status: 'failed', tool: tool.name, proposalId, code: failure.code, message: failure.message, links: [] };
    }
  }

  async reject(proposalId: string, ctx: ToolContext): Promise<void> {
    const existing = await this.options.store.getProposal(proposalId);
    if (!existing || existing.userId !== ctx.userId) throw new ToolError('PROPOSAL_NOT_FOUND', '找不到這個待確認的操作。');
    const moved = await this.options.store.transitionProposal(proposalId, 'pending', 'rejected', { finishedAt: ctx.now().toISOString() });
    if (!moved) throw new ToolError('PROPOSAL_NOT_PENDING', '這個操作已無法取消。');
    await this.options.store.appendAudit({ at: ctx.now().toISOString(), userId: ctx.userId, tool: existing.tool, kind: this.resolve(existing.tool).kind, event: 'rejected', proposalId });
  }
}
