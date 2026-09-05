/**
 * The public share page must not be tracked.
 *
 * `public/isa-track.js` sends `location.pathname`, and on a share link the
 * pathname IS the credential — live tokens were confirmed sitting in
 * `analytics_events.url_path`, readable by anyone with analytics access, for
 * as long as that table is retained. The recipient is also a third party who
 * never agreed to be measured.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTrackedPath } from '@/modules/analytics/isTrackedPath';

describe('isTrackedPath', () => {
  it('excludes the public share page and everything under it', () => {
    expect(isTrackedPath('/share')).toBe(false);
    expect(isTrackedPath('/share/abc123')).toBe(false);
    expect(isTrackedPath('/share/abc123/')).toBe(false);
    // Next hands the App the ROUTE, not the resolved URL, on a dynamic page.
    expect(isTrackedPath('/share/[token]')).toBe(false);
  });

  it('keeps every app page tracked', () => {
    expect(isTrackedPath('/')).toBe(true);
    expect(isTrackedPath('/accounting/reports/report-packs')).toBe(true);
    expect(isTrackedPath('/shared-with-me')).toBe(true);
    expect(isTrackedPath('/sharepoint')).toBe(true);
  });
});

describe('pages/_app.tsx', () => {
  const app = readFileSync(join(__dirname, '../../../pages/_app.tsx'), 'utf8');

  it('mounts TrackerScript behind isTrackedPath', () => {
    // A source read, not a render: _app pulls in five providers and global CSS.
    // The behavioural half of this guard is the isTrackedPath suite above; this
    // half only holds the wiring, which is the part a refactor drops silently.
    expect(app).toMatch(/isTrackedPath\s*\(/);
    expect(app).toMatch(/\{\s*tracked\s*&&\s*<TrackerScript/);
  });
});
