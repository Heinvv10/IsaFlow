/**
 * AP-01 round 10: getSubmissionStatus with no service key answered a MOCK 'processing', which netcash/status applied
 * to an accepted row and stored as Netcash's latest answer. With no key nothing is called and nothing is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSubmissionStatus } from '@/modules/accounting/services/ap/netcashService';

afterEach(() => { vi.unstubAllGlobals(); });

describe('getSubmissionStatus without a service key', () => {
  it.each([[''], ['   ']])('key %j: no request, no mock answer - status unknown', async (key) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await getSubmissionStatus(key.trim(), 'NC-REF');
    expect(result).toEqual({ status: 'unknown', detail: 'Netcash service key is not configured', answered: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
