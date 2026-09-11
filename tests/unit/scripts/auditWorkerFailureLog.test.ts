import { describe, it, expect } from 'vitest';
import { sanitizeAuditWorkerFailure } from '../../../scripts/forensic/auditWorkerFailureLog';

describe('sanitizeAuditWorkerFailure', () => {
  it('carries the error class and message', () => {
    expect(sanitizeAuditWorkerFailure(new TypeError('Explicit audit worker database configuration required')))
      .toEqual({ name: 'TypeError', message: 'Explicit audit worker database configuration required' });
  });

  it('never carries a DATABASE_URL-shaped string', () => {
    const cause = new Error('connect ECONNREFUSED postgres://audit_user:s3cr3t@10.0.0.1:5432/isaflow');
    const sanitized = sanitizeAuditWorkerFailure(cause);
    expect(sanitized.message).not.toMatch(/:\/\//);
    expect(sanitized.message).not.toContain('s3cr3t');
    expect(sanitized).toEqual({ name: 'Error', message: 'connect ECONNREFUSED [redacted]' });
  });

  it('reports a bare type tag for a non-Error throw instead of guessing at a shape', () => {
    expect(sanitizeAuditWorkerFailure('raw string throw')).toEqual({ name: 'string' });
  });
});
