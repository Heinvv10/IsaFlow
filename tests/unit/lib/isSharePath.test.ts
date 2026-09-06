/**
 * `isSharePath` is THE definition of the share-page boundary. Three predicates
 * for this one question existed before it — the analytics tracker's, the
 * service worker's, and `_app.tsx`'s service-worker gate — and a boundary that
 * decides whether a live token gets written down is not a thing to keep three
 * copies of.
 *
 * The boundary is the path SEGMENT: `/sharepoint` is an app page.
 */
import { describe, it, expect } from 'vitest';
import { isSharePath } from '@/lib/paths/isSharePath';
import { isTrackedPath } from '@/modules/analytics/isTrackedPath';

const SHARE = ['/share', '/share/', '/share/abc123', '/share/abc123/', '/share/[token]'];
const NOT_SHARE = ['/', '/accounting/reports/report-packs', '/shared-with-me', '/sharepoint', '/api/accounting/share/links'];

describe('isSharePath', () => {
  it.each(SHARE)('%s is the share page', (p) => expect(isSharePath(p)).toBe(true));
  it.each(NOT_SHARE)('%s is not', (p) => expect(isSharePath(p)).toBe(false));
});

describe('isTrackedPath is derived from it, not a second copy', () => {
  it.each([...SHARE, ...NOT_SHARE])('%s tracks iff it is not the share page', (p) => {
    expect(isTrackedPath(p)).toBe(!isSharePath(p));
  });
});
