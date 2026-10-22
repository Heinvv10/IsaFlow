/**
 * Audit S-08 follow-up C: middleware lets every page under
 * pages/accounting/afs/portal/ through without a staff login (PUBLIC_PATHS
 * '/accounting/afs/portal/'), so each page must gate itself. Every page there
 * but the login page must export getServerSideProps that verifies the portal
 * session and re-reads its standing (verifyPortalToken + currentPortalSession).
 * A new page added without that gate would be public: this fails until it has one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../pages/accounting/afs/portal');
const PUBLIC_PAGES = ['login.tsx'];

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? pages(path) : /\.(tsx|ts|jsx|js)$/.test(name) ? [path] : [];
  });
}

describe('AFS portal pages gate themselves server-side', () => {
  const found = pages(ROOT).map((p) => relative(ROOT, p)).sort();

  it('the census sees the portal pages', () => {
    expect(found).toEqual(expect.arrayContaining(['dashboard.tsx', 'documents/[documentId].tsx', 'login.tsx']));
  });

  it.each(found.filter((p) => !PUBLIC_PAGES.includes(p)))('%s verifies the portal session in getServerSideProps', (page) => {
    const src = readFileSync(join(ROOT, page), 'utf8');
    expect(src).toMatch(/export async function getServerSideProps\(/);
    const ssr = src.slice(src.indexOf('export async function getServerSideProps('));
    expect(ssr).toMatch(/verifyPortalToken\(/);
    expect(ssr).toMatch(/currentPortalSession\(/);
  });
});
