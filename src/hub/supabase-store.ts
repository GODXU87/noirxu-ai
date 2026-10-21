import type { SupabaseClient } from '@supabase/supabase-js';
import type { CredentialBackend, StoredCredential } from '@/connections/credentials';
import type { HubStore } from './store';
import type { AuditEntry, ConnectionId, Proposal, ProposalStatus } from './types';

/**
 * Persists hub state in NOIRXU AI's own Supabase project (see supabase/migrations).
 * The client here uses NOIRXU AI's own server key; it has no access to the source systems.
 */
export class SupabaseHubStore implements HubStore {
  constructor(private readonly db: SupabaseClient) {}

  async createProposal(proposal: Proposal) {
    const { error } = await this.db.from('ai_proposals').insert({ id: proposal.id, user_id: proposal.userId, tool: proposal.tool, status: proposal.status, doc: proposal });
    if (error) throw new Error(`ai_proposals insert failed: ${error.code}`);
  }

  async getProposal(id: string) {
    const { data, error } = await this.db.from('ai_proposals').select('doc').eq('id', id).maybeSingle();
    if (error) throw new Error(`ai_proposals read failed: ${error.code}`);
    return (data?.doc as Proposal | undefined) ?? null;
  }

  async transitionProposal(id: string, from: ProposalStatus, to: ProposalStatus, patch: Partial<Proposal> = {}) {
    const current = await this.getProposal(id);
    if (!current || current.status !== from) return null;
    const next: Proposal = { ...current, ...patch, status: to };
    // The status condition makes this a compare-and-set: only one caller can move it out of `from`.
    const { data, error } = await this.db.from('ai_proposals')
      .update({ status: to, doc: next, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', from).select('doc').maybeSingle();
    if (error) throw new Error(`ai_proposals update failed: ${error.code}`);
    return (data?.doc as Proposal | undefined) ?? null;
  }

  async appendAudit(entry: AuditEntry) {
    const { error } = await this.db.from('ai_audit_log').insert({
      at: entry.at, user_id: entry.userId, tool: entry.tool, kind: entry.kind, event: entry.event,
      proposal_id: entry.proposalId ?? null, record_id: entry.recordId ?? null, error_code: entry.errorCode ?? null, duration_ms: entry.durationMs ?? null
    });
    if (error) throw new Error(`ai_audit_log insert failed: ${error.code}`);
  }
}

export class SupabaseCredentialBackend implements CredentialBackend {
  constructor(private readonly db: SupabaseClient) {}

  async get(userId: string, connection: ConnectionId) {
    const { data, error } = await this.db.from('ai_credentials').select('metadata,sealed,updated_at').eq('user_id', userId).eq('connection', connection).maybeSingle();
    if (error) throw new Error(`ai_credentials read failed: ${error.code}`);
    return data ? { metadata: data.metadata as Record<string, unknown>, sealed: String(data.sealed), updatedAt: String(data.updated_at) } : null;
  }

  async put(userId: string, connection: ConnectionId, value: StoredCredential) {
    const { error } = await this.db.from('ai_credentials').upsert({ user_id: userId, connection, metadata: value.metadata, sealed: value.sealed, updated_at: value.updatedAt });
    if (error) throw new Error(`ai_credentials write failed: ${error.code}`);
  }

  async delete(userId: string, connection: ConnectionId) {
    const { error } = await this.db.from('ai_credentials').delete().eq('user_id', userId).eq('connection', connection);
    if (error) throw new Error(`ai_credentials delete failed: ${error.code}`);
  }
}
