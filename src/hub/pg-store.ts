import type { Pool } from 'pg';
import type { CredentialBackend, StoredCredential } from '@/connections/credentials';
import type { HubStore } from './store';
import type { AuditEntry, ConnectionId, Proposal, ProposalStatus } from './types';

/**
 * Hub state in the `noirxu_ai` schema, reached as the dedicated `noirxu_ai_app` role.
 * That role can read and write only this schema, so this connection has no access to the
 * source systems or to anything else in the hosting project.
 */
export class PgHubStore implements HubStore {
  constructor(private readonly pool: Pool) {}

  async createProposal(proposal: Proposal) {
    await this.pool.query(
      'insert into noirxu_ai.proposals (id, user_id, tool, status, doc) values ($1, $2, $3, $4, $5)',
      [proposal.id, proposal.userId, proposal.tool, proposal.status, proposal]
    );
  }

  async getProposal(id: string) {
    const { rows } = await this.pool.query('select doc from noirxu_ai.proposals where id = $1', [id]);
    return (rows[0]?.doc as Proposal | undefined) ?? null;
  }

  async transitionProposal(id: string, from: ProposalStatus, to: ProposalStatus, patch: Partial<Proposal> = {}) {
    // One statement: the status condition makes it a compare-and-set.
    const { rows } = await this.pool.query(
      `update noirxu_ai.proposals
          set status = $3, doc = doc || $4::jsonb, updated_at = now()
        where id = $1 and status = $2
        returning doc`,
      [id, from, to, JSON.stringify({ ...patch, status: to })]
    );
    return (rows[0]?.doc as Proposal | undefined) ?? null;
  }

  async appendAudit(entry: AuditEntry) {
    await this.pool.query(
      `insert into noirxu_ai.audit_log (at, user_id, tool, kind, event, proposal_id, record_id, error_code, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.at, entry.userId, entry.tool, entry.kind, entry.event, entry.proposalId ?? null, entry.recordId ?? null, entry.errorCode ?? null, entry.durationMs ?? null]
    );
  }
}

export class PgCredentialBackend implements CredentialBackend {
  constructor(private readonly pool: Pool) {}

  async get(userId: string, connection: ConnectionId) {
    const { rows } = await this.pool.query(
      'select metadata, sealed, updated_at from noirxu_ai.credentials where user_id = $1 and connection = $2',
      [userId, connection]
    );
    const row = rows[0];
    return row ? { metadata: row.metadata as Record<string, unknown>, sealed: String(row.sealed), updatedAt: new Date(row.updated_at).toISOString() } : null;
  }

  async put(userId: string, connection: ConnectionId, value: StoredCredential) {
    await this.pool.query(
      `insert into noirxu_ai.credentials (user_id, connection, metadata, sealed, updated_at) values ($1, $2, $3, $4, $5)
       on conflict (user_id, connection) do update set metadata = excluded.metadata, sealed = excluded.sealed, updated_at = excluded.updated_at`,
      [userId, connection, value.metadata, value.sealed, value.updatedAt]
    );
  }

  async delete(userId: string, connection: ConnectionId) {
    await this.pool.query('delete from noirxu_ai.credentials where user_id = $1 and connection = $2', [userId, connection]);
  }
}
