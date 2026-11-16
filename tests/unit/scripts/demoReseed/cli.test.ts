import { describe, expect, it } from 'vitest';
import {
  Refusal, assertDemoCompany, assertTodayNotFuture, describeTarget, parseArgs, resolveDbUrl,
} from '../../../../scripts/lib/demoReseed/cli';
import { DEMO_COMPANY_ID } from '../../../../scripts/lib/demoReseed/constants';

describe('reseed CLI contract', () => {
  it('refuses to run without --company', () => {
    expect(() => parseArgs([])).toThrow(/refusing to run without --company/);
    expect(() => assertDemoCompany(undefined)).toThrow(Refusal);
  });

  it('refuses any company but the Demo company', () => {
    expect(() => parseArgs(['--company', '11111111-1111-1111-1111-111111111111'])).toThrow(/only the Demo company/);
    expect(() => parseArgs(['--company', `${DEMO_COMPANY_ID}x`])).toThrow(Refusal);
  });

  it('accepts the Demo id in upper case and in --company= form', () => {
    expect(parseArgs(['--company', DEMO_COMPANY_ID.toUpperCase()]).companyId).toBe(DEMO_COMPANY_ID);
    expect(parseArgs([`--company=${DEMO_COMPANY_ID}`]).mode).toBe('run');
  });

  it('keeps --dry-run and --check-only apart', () => {
    expect(parseArgs(['--company', DEMO_COMPANY_ID, '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--company', DEMO_COMPANY_ID, '--check-only']).mode).toBe('check-only');
    expect(() => parseArgs(['--company', DEMO_COMPANY_ID, '--dry-run', '--check-only'])).toThrow(/exclude each other/);
  });

  it('refuses unknown arguments and bad dates', () => {
    expect(() => parseArgs(['--company', DEMO_COMPANY_ID, '--force'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--company', DEMO_COMPANY_ID, '--today', '2026-02-30'])).toThrow(/not a calendar day/);
  });

  it('refuses a --today after the database date', () => {
    expect(() => assertTodayNotFuture('2026-11-17', '2026-11-16')).toThrow(Refusal);
    expect(() => assertTodayNotFuture('2026-11-16', '2026-11-16')).not.toThrow();
  });

  it('reads the URL only from DEMO_RESEED_DATABASE_URL', () => {
    expect(() => resolveDbUrl({ DATABASE_URL: 'postgresql://x@h/db' })).toThrow(/DEMO_RESEED_DATABASE_URL/);
    expect(resolveDbUrl({ DEMO_RESEED_DATABASE_URL: 'postgresql://x@h/db' })).toBe('postgresql://x@h/db');
  });

  it('never prints the password, whatever characters it holds', () => {
    const secret = 'p@ss:w/rd%23?x';
    // Built through URL so no credential-shaped literal sits in the source.
    const u = new URL('postgresql://db.example.co.za:6543/demo_copy?sslmode=disable');
    u.username = 'reseeder';
    u.password = secret;
    const t = describeTarget(u.toString());
    expect(t).toBe('host=db.example.co.za port=6543 database=demo_copy user=reseeder');
    expect(t).not.toContain(encodeURIComponent(secret));
    expect(t).not.toContain('w/rd');
  });
});
