import type { ConnectionId } from '@/hub/types';
import { TokenVault } from './vault';

export interface StoredCredential {
  /** Non-secret facts safe to show in the UI (account email, granted scopes, connected time). */
  metadata: Record<string, unknown>;
  /** Encrypted secret payload; only this module ever decrypts it. */
  sealed: string;
  updatedAt: string;
}

export interface CredentialBackend {
  get(userId: string, connection: ConnectionId): Promise<StoredCredential | null>;
  put(userId: string, connection: ConnectionId, value: StoredCredential): Promise<void>;
  delete(userId: string, connection: ConnectionId): Promise<void>;
}

export class MemoryCredentialBackend implements CredentialBackend {
  private readonly rows = new Map<string, StoredCredential>();
  async get(userId: string, connection: ConnectionId) {
    return this.rows.get(`${userId}:${connection}`) ?? null;
  }
  async put(userId: string, connection: ConnectionId, value: StoredCredential) {
    this.rows.set(`${userId}:${connection}`, value);
  }
  async delete(userId: string, connection: ConnectionId) {
    this.rows.delete(`${userId}:${connection}`);
  }
}

/** Encrypts on write and decrypts on read; secrets never leave the server. */
export class CredentialStore {
  constructor(private readonly backend: CredentialBackend, private readonly vault: TokenVault) {}

  private aad(userId: string, connection: ConnectionId) {
    return `noirxu-ai:${userId}:${connection}`;
  }

  async save<T extends object>(userId: string, connection: ConnectionId, secret: T, metadata: Record<string, unknown>): Promise<void> {
    await this.backend.put(userId, connection, {
      metadata,
      sealed: this.vault.seal(JSON.stringify(secret), this.aad(userId, connection)),
      updatedAt: new Date().toISOString()
    });
  }

  async load<T>(userId: string, connection: ConnectionId): Promise<{ secret: T; metadata: Record<string, unknown> } | null> {
    const row = await this.backend.get(userId, connection);
    if (!row) return null;
    return { secret: JSON.parse(this.vault.open(row.sealed, this.aad(userId, connection))) as T, metadata: row.metadata };
  }

  async metadata(userId: string, connection: ConnectionId): Promise<Record<string, unknown> | null> {
    return (await this.backend.get(userId, connection))?.metadata ?? null;
  }

  async remove(userId: string, connection: ConnectionId): Promise<void> {
    await this.backend.delete(userId, connection);
  }
}
