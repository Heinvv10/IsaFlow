/**
 * THE TWO SURFACES A PACK RENDER SHOWS THE OUTSIDE WORLD, HELD SHUT.
 *
 * A blind security review of this branch raised no CRITICAL and no HIGH; its
 * two MEDIUMs and one of its LOWs are here.
 *
 *  - `packRefusalMessages` fell through to `user: error.message` for anything
 *    that is not a `PackRefusal`, and `packs/[id]/pdf.ts` wraps the WHOLE of
 *    `buildBoardPackDocument` in one catch — so a node-postgres driver error,
 *    a `TypeError` from a composition module or an assertion naming an
 *    internal function was returned verbatim to the caller in a 422 body. The
 *    class of message was bounded by nothing.
 *  - `resolvePackBrand` passed the stored `logoUrl` through unvalidated, and
 *    the cover renders it as `<img src>` inside a headless browser. The SSRF
 *    check lives on the WRITE path, so it is a point-in-time DNS decision.
 *
 * The route's date validation is in `tests/unit/api/packsDownloadRoutes.test.ts`,
 * where the route already has a harness.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const checkPublicUrlMock = vi.fn(async (_url: string): Promise<string | null> => null);
vi.mock('@/lib/safeFetch', () => ({
  checkPublicUrl: (url: string) => checkPublicUrlMock(url),
}));
const warn = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() } }));

import {
  PackRefusal,
  packRefusalMessages,
  UNEXPLAINED_FAILURE,
} from '@/modules/accounting/services/packs/packRefusal';
import { resolvePackBrand } from '@/modules/accounting/services/packs/packBrand';
import { resolvePackBrandForRender } from '@/modules/accounting/services/packs/packBrandForRender';
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

describe('what a failed pack render is allowed to tell its caller', () => {
  /**
   * THE HALF THAT MUST NOT CHANGE. The integrity gate's sentences are written
   * for a reader — "the balance sheet is out by R450 on …" is the whole value
   * of the gate — and they all reach the route through `PackRefusal`.
   */
  it('returns the gate\'s own sentence for a refusal written for a reader', () => {
    const refusal = new PackRefusal(
      'fitPageToBox: page 5 needs 264.9mm of a 255.0mm box',
      'This pack could not be laid out on twelve sheets.',
    );
    expect(packRefusalMessages(refusal)).toEqual({
      user: 'This pack could not be laid out on twelve sheets.',
      diagnostic: 'fitPageToBox: page 5 needs 264.9mm of a 255.0mm box',
    });
  });

  /**
   * AND THE HALF THAT DID. Every one of these is a real shape the compose
   * stack can throw; none of them is a sentence anyone wrote for a director,
   * and each was returned to the client verbatim.
   */
  it.each([
    ['a driver error naming a relation and a value',
      new Error('duplicate key value violates unique constraint "uq_gl_je" Key (entry_number)=(JE-2026-00085)')],
    ['a driver error naming an invalid literal',
      new Error('date/time field value out of range: "2026-02-31"')],
    ['an internal assertion naming a function',
      new Error('assertPackIntegrity: locateFigures returned no source for kpiTiles[3]')],
    ['a programming error', new TypeError('Cannot read properties of undefined (reading \'rows\')')],
  ])('says nothing about %s', (unused, error) => {
    const { user, diagnostic } = packRefusalMessages(error);
    expect(user).toBe(UNEXPLAINED_FAILURE);
    // Nothing of the original reaches the reader — asserted against the
    // error's own words rather than against a pattern, so a new leak shape
    // fails this too.
    for (const word of (error as Error).message.split(/[\s"']+/).filter((w) => w.length > 6)) {
      expect(user, `the user message quotes "${word}" from the exception`).not.toContain(word);
    }
    // And the engineer still gets all of it.
    expect(diagnostic).toBe((error as Error).message);
  });

  it('says nothing about a thrown non-Error either', () => {
    expect(packRefusalMessages({ password: 'hunter2' }).user).toBe(UNEXPLAINED_FAILURE);
    expect(packRefusalMessages('ECONNREFUSED 10.0.0.7:5432').user).toBe(UNEXPLAINED_FAILURE);
  });
});

const profile = (logoUrl: string | null): BrandProfile => ({
  id: 'b1', companyId: 'c1', logoUrl,
  primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', reportFooterText: null,
} as BrandProfile);

describe('the logo the headless browser is asked to fetch', () => {
  beforeEach(() => {
    checkPublicUrlMock.mockReset();
    checkPublicUrlMock.mockResolvedValue(null);
    warn.mockReset();
  });

  it('keeps a logo whose host is still a public target', async () => {
    const brand = await resolvePackBrandForRender(profile('https://cdn.example.com/logo.png'));
    expect(brand.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(checkPublicUrlMock).toHaveBeenCalledWith('https://cdn.example.com/logo.png');
  });

  /**
   * THE ONE THE WRITE-TIME CHECK CANNOT CATCH: a host that resolved publicly
   * when the profile was saved and resolves to a reserved address now.
   */
  it('drops a logo that now resolves to a blocked address, and renders anyway', async () => {
    checkPublicUrlMock.mockResolvedValue('logo.tenant.example resolves to blocked address 169.254.169.254: link-local');
    const brand = await resolvePackBrandForRender(profile('https://logo.tenant.example/l.png'));
    expect(brand.logoUrl).toBeNull();
    // SUBSTITUTE, DO NOT REFUSE — the colours are still resolved and the pack
    // still composes, exactly as an unreadable brand colour is replaced.
    expect(brand.primaryColour).toBe('#1a3a5c');
    expect(warn).toHaveBeenCalled();
  });

  it('asks nothing of the network when there is no logo', async () => {
    expect((await resolvePackBrandForRender(profile(null))).logoUrl).toBeNull();
    expect(checkPublicUrlMock).not.toHaveBeenCalled();
  });

  /** The pure resolver is unchanged and still does no I/O — it is what the
   *  colour tests and any non-render caller use. */
  it('leaves the pure resolver pure', () => {
    expect(resolvePackBrand(profile('https://logo.tenant.example/l.png')).logoUrl)
      .toBe('https://logo.tenant.example/l.png');
    expect(checkPublicUrlMock).not.toHaveBeenCalled();
  });
});
