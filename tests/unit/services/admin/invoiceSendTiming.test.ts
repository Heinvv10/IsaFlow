/**
 * WP7 review round 3 of #1368: a Send's claim may be settled only once it is older than SEND_SETTLE_AFTER_MS,
 * which must stay above the SMTP ceiling plus the claim and finalise lock bounds; and the age the settle dialog
 * states.
 */
import { describe, expect, it } from 'vitest';
import { claimAgeText, isClaimSettleable, SEND_SETTLE_AFTER_MS, SMTP_TIMEOUTS_MS } from '@/modules/admin/services/invoiceSendTiming';
import { OWN_TX_LOCK_TIMEOUT } from '@/lib/auth/platformAdminOwnTx';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('SEND_SETTLE_AFTER_MS', () => {
  it('is above the SMTP ceiling plus two 5 s lock bounds (claim, finalise)', () => {
    const smtp = SMTP_TIMEOUTS_MS.connection + SMTP_TIMEOUTS_MS.greeting + SMTP_TIMEOUTS_MS.socket;
    expect(smtp).toBe(50_000);
    expect(OWN_TX_LOCK_TIMEOUT).toBe('5s');
    expect(SEND_SETTLE_AFTER_MS).toBeGreaterThan(smtp + 2 * 5_000);
    expect(SEND_SETTLE_AFTER_MS).toBe(120_000);
  });

  it.each([
    [0, false], [50_000, false], [119_999, false], [120_000, true], [3_600_000, true],
  ])('a claim %i ms old is settleable: %s', (age, ok) => {
    expect(isClaimSettleable(ago(age), NOW)).toBe(ok);
    expect(isClaimSettleable(new Date(NOW - age), NOW)).toBe(ok);
  });

  it('an unreadable timestamp is never settleable', () => {
    expect(isClaimSettleable('not a date', NOW)).toBe(false);
  });
});

describe('claimAgeText', () => {
  it.each([
    [10_000, 'under a minute'], [60_000, '1 minute'], [12 * 60_000, '12 minutes'],
    [60 * 60_000, '1 hour'], [47 * 3_600_000, '47 hours'], [72 * 3_600_000, '3 days'],
  ])('%i ms -> %s', (age, text) => {
    expect(claimAgeText(ago(age), NOW)).toBe(text);
  });
});
