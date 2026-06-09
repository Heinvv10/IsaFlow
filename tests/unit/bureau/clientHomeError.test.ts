import { describe, it, expect } from 'vitest';
import { bureauClientErrorMessage } from '@/components/bureau/clientHomeError';

describe('bureauClientErrorMessage', () => {
  it('returns the bureau-specific copy for a 404 regardless of body', () => {
    expect(bureauClientErrorMessage(404, {})).toBe('This client is not in your bureau.');
    expect(bureauClientErrorMessage(404, { error: { message: 'Client not found' } }))
      .toBe('This client is not in your bureau.');
  });

  it('surfaces the server error.message for non-404 failures', () => {
    expect(bureauClientErrorMessage(500, { error: { message: 'Boom' } })).toBe('Boom');
  });

  it('falls back to a top-level message field if present (back-compat)', () => {
    expect(bureauClientErrorMessage(500, { message: 'Legacy' })).toBe('Legacy');
  });

  it('defaults to "Failed to load" when no message is present', () => {
    expect(bureauClientErrorMessage(500, {})).toBe('Failed to load');
  });
});
