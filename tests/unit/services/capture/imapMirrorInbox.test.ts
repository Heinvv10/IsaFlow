import { describe, it, expect } from 'vitest';
import { isTransientIngestError } from '@/modules/accounting/services/capture/imapMirrorInbox';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('isTransientIngestError (IMAP mirror retry)', () => {
  it.each(['42501', '55P03', '08006', '53300', '57014'])('a database failure %s is retried', (code) => {
    expect(isTransientIngestError(pgError(code))).toBe(true);
  });

  it('a pool checkout timeout is retried', () => {
    expect(isTransientIngestError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it.each([pgError('23505'), pgError('22P02'), new Error('PDF parse failed'), 'boom', null])(
    'a failure of the message itself (%s) is not', (err) => {
      expect(isTransientIngestError(err)).toBe(false);
    });
});
