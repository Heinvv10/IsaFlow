/**
 * The one helper that turns a failed API call into a line a person can act on.
 *
 * Two error classes count and everything else does not. `ApiRequestError`
 * carries the server's own message; `ApiEnvelopeError` says the route answered
 * 2xx with a body that was not the shape it promised, which is a real failure
 * and worth saying out loud. A dropped connection produces a TypeError whose
 * message is about the transport, so the caller's fallback is what a person
 * should read instead.
 */
import { describe, it, expect } from 'vitest';
import { apiErrorMessage, ApiRequestError, ApiEnvelopeError } from '@/lib/apiFetch';

describe('apiErrorMessage', () => {
  it("uses the server's message from an ApiRequestError", () => {
    const err = new ApiRequestError('This company already has 10 live share links.', 409);
    expect(apiErrorMessage(err, 'Could not create the share link.'))
      .toBe('This company already has 10 live share links.');
  });

  it('uses the envelope error message rather than hiding a wrong-shape response', () => {
    const err = new ApiEnvelopeError('The link was created but its URL was not returned.');
    expect(apiErrorMessage(err, 'Could not create the share link.'))
      .toBe('The link was created but its URL was not returned.');
  });

  it('falls back for any other throw, whose message is not about the task', () => {
    expect(apiErrorMessage(new TypeError('Failed to fetch'), 'Could not load commentary.'))
      .toBe('Could not load commentary.');
    expect(apiErrorMessage('boom', 'Could not load commentary.')).toBe('Could not load commentary.');
    expect(apiErrorMessage(undefined, 'Could not load commentary.')).toBe('Could not load commentary.');
  });
});
