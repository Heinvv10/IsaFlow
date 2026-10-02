import { describe, it, expect } from 'vitest';
import { bureauClientErrorMessage } from '@/components/bureau/clientHomeError';
import { ApiEnvelopeError, ApiRequestError } from '@/lib/apiFetch';

describe('bureauClientErrorMessage', () => {
  it('returns the bureau-specific copy for a 404 regardless of the server message', () => {
    expect(bureauClientErrorMessage(new ApiRequestError('Client not found', 404))).toBe('This client is not in your bureau.');
  });

  it('surfaces the server message for other failures', () => {
    expect(bureauClientErrorMessage(new ApiRequestError('Boom', 500))).toBe('Boom');
    expect(bureauClientErrorMessage(new ApiEnvelopeError('Odd body'))).toBe('Odd body');
  });

  it('is a plain sentence for a transport failure', () => {
    expect(bureauClientErrorMessage(new TypeError('Failed to fetch'))).toBe('Could not load this client - try again');
  });
});
