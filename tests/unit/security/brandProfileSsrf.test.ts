/**
 * Pentest re-run H2 — AFS brand-profile logoUrl SSRF.
 *
 * The logo URL is fetched server-side by WeasyPrint when rendering AFS PDFs. The Zod
 * schema only enforces https:// + length, so an https URL pointing at an internal /
 * metadata address (e.g. https://169.254.169.254/) is an SSRF sink. The PUT handler now
 * re-resolves the URL via checkPublicUrl and rejects private/reserved targets before storing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', () => ({
  withAuth: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: (req: NextApiRequest, res: NextApiResponse) => unknown) => h,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { checkPublicUrlMock } = vi.hoisted(() => ({ checkPublicUrlMock: vi.fn() }));
vi.mock('@/lib/safeFetch', () => ({ checkPublicUrl: checkPublicUrlMock }));

// The out-for-signature warning reads the database; it is proven against PostgreSQL in
// tests/integration/controls/afsSigningInputsHttp.int.test.ts.
vi.mock('@/modules/accounting/services/afs/afsSigningIntegrity', () => ({ signingInvalidationWarnings: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/afs/brandProfileService', () => ({
  getBrandProfile: vi.fn(),
  upsertBrandProfile: vi.fn().mockResolvedValue({ id: 'bp1' }),
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn(), badRequest: vi.fn(), zodValidationError: vi.fn(), methodNotAllowed: vi.fn(),
  },
}));

import { apiResponse } from '@/lib/apiResponse';
import { upsertBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/afs/brand-profile';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function makeReq(body: Record<string, unknown>): NextApiRequest {
  return {
    method: 'PUT', query: {}, body,
    companyId: '11111111-1111-4111-9111-111111111111',
  } as unknown as NextApiRequest;
}
function makeRes(): NextApiResponse {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('brand-profile H2 — logoUrl SSRF guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a logoUrl that resolves to a blocked address', async () => {
    checkPublicUrlMock.mockResolvedValue('blocked address 169.254.169.254: link-local');
    await (handler as Handler)(makeReq({ logoUrl: 'https://169.254.169.254/logo.png' }), makeRes());
    expect(checkPublicUrlMock).toHaveBeenCalledWith('https://169.254.169.254/logo.png');
    expect(apiResponse.badRequest).toHaveBeenCalledTimes(1);
    expect(upsertBrandProfile).not.toHaveBeenCalled();
  });

  it('allows a logoUrl that resolves to a public address', async () => {
    checkPublicUrlMock.mockResolvedValue(null);
    await (handler as Handler)(makeReq({ logoUrl: 'https://cdn.example.com/logo.png' }), makeRes());
    expect(apiResponse.badRequest).not.toHaveBeenCalled();
    expect(upsertBrandProfile).toHaveBeenCalledTimes(1);
  });

  it('skips the SSRF check when no logoUrl is supplied', async () => {
    await (handler as Handler)(makeReq({ primaryColour: '#112233' }), makeRes());
    expect(checkPublicUrlMock).not.toHaveBeenCalled();
    expect(upsertBrandProfile).toHaveBeenCalledTimes(1);
  });
});
