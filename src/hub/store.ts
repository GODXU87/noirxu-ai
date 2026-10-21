import type { AuditEntry, Proposal, ProposalStatus } from './types';

export interface HubStore {
  createProposal(proposal: Proposal): Promise<void>;
  getProposal(id: string): Promise<Proposal | null>;
  /**
   * Atomically move a proposal from one status to another. Returns the updated proposal,
   * or null when the proposal was not in `from` (another request already moved it).
   */
  transitionProposal(id: string, from: ProposalStatus, to: ProposalStatus, patch?: Partial<Proposal>): Promise<Proposal | null>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

/**
 * Process-local store. Used by tests and `next dev`; state is lost on restart, so production
 * must use the database-backed store (see `supabase-store.ts`).
 */
export class MemoryHubStore implements HubStore {
  readonly proposals = new Map<string, Proposal>();
  readonly audit: AuditEntry[] = [];

  async createProposal(proposal: Proposal) {
    if (this.proposals.has(proposal.id)) throw new Error('duplicate proposal id');
    this.proposals.set(proposal.id, structuredClone(proposal));
  }

  async getProposal(id: string) {
    const found = this.proposals.get(id);
    return found ? structuredClone(found) : null;
  }

  async transitionProposal(id: string, from: ProposalStatus, to: ProposalStatus, patch: Partial<Proposal> = {}) {
    const found = this.proposals.get(id);
    if (!found || found.status !== from) return null;
    const next = { ...found, ...patch, status: to };
    this.proposals.set(id, next);
    return structuredClone(next);
  }

  async appendAudit(entry: AuditEntry) {
    this.audit.push(entry);
  }
}
