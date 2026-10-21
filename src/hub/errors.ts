export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'UNKNOWN_TOOL'
  | 'NOT_CONFIGURED'
  | 'NOT_CONNECTED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NEEDS_USER_DECISION'
  | 'UPSTREAM_REJECTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'OUTCOME_UNKNOWN'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_NOT_PENDING'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  return new ToolError('INTERNAL', '內部錯誤，操作未完成。');
}

// Upstream error text may echo request data; keep only a short, single-line code-like prefix.
export function safeUpstreamMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : (value as { message?: unknown })?.message;
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 160);
}
