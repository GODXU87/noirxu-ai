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

// A global brand, so a ToolError is recognised even when it was created by another bundle
// (the shared hub can be built inside a different route's bundle than the one catching).
const BRAND = Symbol.for('noirxu-ai.ToolError');

export class ToolError extends Error {
  readonly [BRAND] = true;
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError || Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[BRAND] === true);
}

export function toToolError(error: unknown): ToolError {
  if (isToolError(error)) return error;
  return new ToolError('INTERNAL', '內部錯誤，操作未完成。');
}
