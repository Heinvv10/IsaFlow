/**
 * postingPeriodBlock decides whether a journal (and a bank transfer, before it writes one) may post on its
 * accounting date. Lockdown ENABLED with NO date locks every date: dropping that branch would let every journal and
 * transfer post into a locked-down company, and nothing else tested it.
 */
import { describe, expect, it } from 'vitest';
import { lockdownBlock, postingPeriodBlock } from '@/modules/accounting/services/gl/postingPeriodGuard';

const open = 'open', unlocked = { lockdown_enabled: false, lockdown_date: null };

describe('postingPeriodBlock', () => {
  it('lets an open period in an unlocked company post', () => {
    expect(postingPeriodBlock(open, unlocked, '2026-09-09')).toBeNull();
  });

  it('blocks a period that is not open, unless an authorised posting targets a CLOSED one', () => {
    expect(postingPeriodBlock('closed', unlocked, '2026-09-09')).toEqual({ kind: 'period', status: 'closed' });
    expect(postingPeriodBlock('locked', unlocked, '2026-09-09')).toEqual({ kind: 'period', status: 'locked' });
    expect(postingPeriodBlock('closed', unlocked, '2026-09-09', true)).toBeNull();
    expect(postingPeriodBlock('locked', unlocked, '2026-09-09', true), 'authorisation opened a locked period').toEqual({ kind: 'period', status: 'locked' });
  });

  it('locks EVERY date while lockdown is enabled with no date', () => {
    const lockedDown = { lockdown_enabled: true, lockdown_date: null };
    for (const date of ['1999-01-01', '2026-09-09', '2099-12-31']) {
      expect(postingPeriodBlock(open, lockedDown, date), `${date} posted into a company locked down with no date`)
        .toEqual({ kind: 'lockdown', lockdownDate: null });
    }
  });

  it('locks dates up to and including the lockdown date, and none after it', () => {
    const lockedTo = { lockdown_enabled: true, lockdown_date: '2026-09-15' };
    expect(postingPeriodBlock(open, lockedTo, '2026-09-15')).toEqual({ kind: 'lockdown', lockdownDate: '2026-09-15' });
    expect(postingPeriodBlock(open, lockedTo, '2026-09-01')).toEqual({ kind: 'lockdown', lockdownDate: '2026-09-15' });
    expect(postingPeriodBlock(open, lockedTo, '2026-09-16')).toBeNull();
  });

  it('ignores a lockdown date while lockdown is disabled', () => {
    expect(postingPeriodBlock(open, { lockdown_enabled: false, lockdown_date: '2026-09-15' }, '2026-09-01')).toBeNull();
  });
});

describe('lockdownBlock (the one lockdown rule every writer shares)', () => {
  const dated = { lockdown_enabled: true, lockdown_date: '2026-09-15' };
  it('blocks a date on or before the lockdown date and allows the day after', () => {
    expect(lockdownBlock(dated, '2026-09-15')).toEqual({ kind: 'lockdown', lockdownDate: '2026-09-15' });
    expect(lockdownBlock(dated, '2026-09-14')).toEqual({ kind: 'lockdown', lockdownDate: '2026-09-15' });
    expect(lockdownBlock(dated, '2026-09-16')).toBeNull();
  });
  it('blocks every date when lockdown is enabled with no date', () => {
    expect(lockdownBlock({ lockdown_enabled: true, lockdown_date: null }, '2099-12-31')).toEqual({ kind: 'lockdown', lockdownDate: null });
    expect(lockdownBlock({ lockdown_enabled: true }, '1900-01-01')).toEqual({ kind: 'lockdown', lockdownDate: null });
  });
  it('blocks nothing when lockdown is off, whatever the stored date says', () => {
    expect(lockdownBlock({ lockdown_enabled: false, lockdown_date: '2026-09-15' }, '2020-01-01')).toBeNull();
    expect(lockdownBlock({ lockdown_enabled: null, lockdown_date: null }, '2020-01-01')).toBeNull();
  });
  it('is the rule postingPeriodBlock applies once the period is open', () => {
    expect(postingPeriodBlock('closed', dated, '2026-09-01', true)).toEqual(lockdownBlock(dated, '2026-09-01'));
  });
});
