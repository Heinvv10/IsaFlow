import type { TransactionOutcome } from '@/modules/accounting/services/controls/transactionObservers';
export type InvocationStatus = 'ok' | 'rejected' | 'error' | 'replay';
export const INVOCATION_REASON_CODES = ['SUCCESS', 'TOOL_REJECTED', 'HANDLER_ERROR', 'REPLAY', 'VALIDATION_REJECTED',
  'AUTHORITY_REJECTED', 'IDEMPOTENCY_CONFLICT', 'COMPLETION_MISSING'] as const;
export interface InvocationCompletion {
  status: InvocationStatus;
  reportedWrite: boolean;
  durationMs: number;
  reasonCode?: typeof INVOCATION_REASON_CODES[number];
}
export interface InvocationAdmissionInput { tool: string; argsHash: string; idempotencyKeyHash: string | null }
export interface InvocationSummary {
  attemptId: string; tool: string; admittedAt: string; personId: string;
  transactionOutcome: TransactionOutcome; status: InvocationStatus | null;
  reportedWrite: boolean | null; reasonCode: string | null; durationMs: number | null;
  settledAt: string | null;
}
export class InvocationStoreError extends Error {
  readonly code = 'INVOCATION_UNAVAILABLE';
  constructor() { super('Durable invocation evidence is unavailable'); this.name = 'InvocationStoreError'; }
}
