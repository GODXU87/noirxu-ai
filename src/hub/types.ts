import type { z } from 'zod';
import type { ToolErrorCode } from './errors';

export const CONNECTION_IDS = ['ledger', 'journal', 'radar', 'gmail'] as const;
export type ConnectionId = (typeof CONNECTION_IDS)[number];

/** read: no side effects. write: creates a record in a source system. send: sends something outward (email). */
export type ToolKind = 'read' | 'write' | 'send';

export interface SourceLink {
  label: string;
  url: string;
}

export interface ToolContext {
  userId: string;
  now: () => Date;
}

export interface ProposalPreview {
  title: string;
  /** Every field the user is approving, shown verbatim. */
  fields: Array<{ label: string; value: string }>;
  /** Long text shown in full (e.g. an email body). */
  body?: string;
  warnings?: string[];
}

export interface RunMeta {
  /** Stable per proposal; reused on every retry of the same proposal. */
  idempotencyKey: string;
  /** When execution of this proposal started (for reconciliation). */
  startedAt: Date;
}

export interface ToolRunResult<O> {
  data: O;
  links?: SourceLink[];
  /** For record-creating tools: the id the source system returned. */
  recordId?: string;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  connection: ConnectionId;
  kind: ToolKind;
  input: I;
  output: O;
  /** Required for write/send tools: what the user sees before approving. */
  preview?: (input: z.output<I>, ctx: ToolContext) => Promise<ProposalPreview>;
  run: (input: z.output<I>, ctx: ToolContext, meta: RunMeta) => Promise<ToolRunResult<z.output<O>>>;
  /**
   * Optional: after an OUTCOME_UNKNOWN failure, look for records that may have been created,
   * so the user can check instead of the hub re-sending blindly.
   */
  reconcile?: (input: z.output<I>, ctx: ToolContext, meta: RunMeta) => Promise<{ candidates: unknown[]; links?: SourceLink[] }>;
}

export type ProposalStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'outcome_unknown' | 'rejected';

export interface Proposal {
  id: string;
  userId: string;
  tool: string;
  input: unknown;
  preview: ProposalPreview;
  idempotencyKey: string;
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  recordId?: string;
  links?: SourceLink[];
  error?: { code: ToolErrorCode; message: string };
}

export interface AuditEntry {
  at: string;
  userId: string;
  tool: string;
  kind: ToolKind;
  event: 'read' | 'proposed' | 'confirmed' | 'succeeded' | 'failed' | 'outcome_unknown' | 'rejected';
  proposalId?: string;
  recordId?: string;
  errorCode?: ToolErrorCode;
  durationMs?: number;
}

export type InvokeResult =
  | { status: 'ok'; tool: string; data: unknown; links: SourceLink[] }
  | { status: 'confirmation_required'; tool: string; proposalId: string; preview: ProposalPreview; expiresAt: string }
  | { status: 'error'; tool: string; code: ToolErrorCode; message: string };

export type ConfirmResult =
  | { status: 'succeeded'; tool: string; proposalId: string; data: unknown; recordId?: string; links: SourceLink[] }
  | { status: 'failed' | 'outcome_unknown'; tool: string; proposalId: string; code: ToolErrorCode; message: string; candidates?: unknown[]; links: SourceLink[] };
