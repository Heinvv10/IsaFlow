import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountToCategory, aggregatePool, MIN_AGREEMENT, MIN_DISTINCT_COMPANIES, type PoolObservation,
} from '@/modules/accounting/services/sharedPool/merchantPool';

const co = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const companies = (n: number, from = 1) => Array.from({ length: n }, (_, i) => co(from + i));
const obs = (companyId: string, text: string, categoryCode: string, weight = 1): PoolObservation => ({ companyId, text, categoryCode, weight });
const all = (ids: string[]) => new Set(ids);

describe('aggregatePool — thresholds', () => {
  it('4 companies agreeing is not published; 5 is', () => {
    const four = companies(4);
    expect(aggregatePool(four.map((c) => obs(c, 'ENGEN SANDTON', 'fuel')), all(four)).rows).toEqual([]);
    const five = companies(5);
    expect(aggregatePool(five.map((c) => obs(c, 'ENGEN SANDTON', 'fuel')), all(five)).rows).toEqual([
      { merchant: 'ENGEN', category: 'fuel', companies: 5, agreement: 1, observations: 5 },
    ]);
  });

  it('agreement below the threshold is not published (3 of 5 = 0.6)', () => {
    const ids = companies(5);
    const o = ids.map((c, i) => obs(c, 'VODACOM', i < 3 ? 'telephone' : 'internet'));
    expect(aggregatePool(o, all(ids)).rows).toEqual([]);
  });

  it('agreement exactly at the threshold is published (4 of 5 = 0.8)', () => {
    const ids = companies(5);
    const o = ids.map((c, i) => obs(c, 'VODACOM', i < 4 ? 'telephone' : 'internet'));
    expect(aggregatePool(o, all(ids)).rows).toEqual([{ merchant: 'VODACOM', category: 'telephone', companies: 5, agreement: 0.8, observations: 5 }]);
  });

  it('agreement just under the threshold is not published (7 of 9 = 0.7777)', () => {
    const ids = companies(9);
    const o = ids.map((c, i) => obs(c, 'MTN', i < 7 ? 'telephone' : 'internet'));
    expect(aggregatePool(o, all(ids)).rows).toEqual([]);
  });

  it('pins the constants: k = 5 (Hein), agreement 0.8', () => {
    expect(MIN_DISTINCT_COMPANIES).toBe(5);
    expect(MIN_AGREEMENT).toBe(0.8);
  });

  it('the constants are the CHECK constraints on shared_merchant_patterns (migration 931)', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts/migrations/sql/931_shared_merchant_patterns.sql'), 'utf8');
    expect(sql).toContain(`CHECK (distinct_company_count >= ${MIN_DISTINCT_COMPANIES})`);
    expect(sql).toContain(`CHECK (agreement_pct >= ${MIN_AGREEMENT} AND agreement_pct <= 1)`);
  });
});

describe('aggregatePool — who counts', () => {
  it('ignores ineligible companies: 5 companies seen but one ineligible -> not published', () => {
    const ids = companies(5);
    const o = ids.map((c) => obs(c, 'ESKOM', 'electricity'));
    const r = aggregatePool(o, all(ids.slice(0, 4)));
    expect(r.rows).toEqual([]);
    expect(r.stats.ineligibleDropped).toBe(1);
  });

  it('one company = one vote, however many lines it has', () => {
    const ids = companies(5);
    // One company codes ENGEN to "travel" 1000 times; four code it to fuel once each.
    const o = [obs(ids[0]!, 'ENGEN', 'travel', 1000), ...ids.slice(1).map((c) => obs(c, 'ENGEN', 'fuel'))];
    expect(aggregatePool(o, all(ids)).rows).toEqual([
      { merchant: 'ENGEN', category: 'fuel', companies: 5, agreement: 0.8, observations: 1004 },
    ]);
  });

  it("a company's vote is its own majority", () => {
    const ids = companies(5);
    const o = [
      ...ids.map((c) => obs(c, 'SHELL', 'fuel', 3)),
      obs(ids[0]!, 'SHELL', 'meals_entertainment', 1),
    ];
    expect(aggregatePool(o, all(ids)).rows[0]).toMatchObject({ merchant: 'SHELL', category: 'fuel', companies: 5, agreement: 1 });
  });

  it('a company tied between two categories abstains (does not count towards k)', () => {
    const ids = companies(5);
    const o = [
      ...ids.slice(0, 4).map((c) => obs(c, 'TELKOM', 'telephone')),
      obs(ids[4]!, 'TELKOM', 'telephone'), obs(ids[4]!, 'TELKOM', 'internet'),
    ];
    expect(aggregatePool(o, all(ids)).rows).toEqual([]);
  });

  it('a non-poolable category (salaries) is never published even with full agreement', () => {
    const ids = companies(6);
    expect(aggregatePool(ids.map((c) => obs(c, 'ACME HOLDINGS', 'salaries')), all(ids)).rows).toEqual([]);
  });

  it('an unknown category code is dropped', () => {
    const ids = companies(5);
    expect(aggregatePool(ids.map((c) => obs(c, 'ENGEN', 'made_up')), all(ids)).rows).toEqual([]);
  });
});

describe('aggregatePool — the PII filter runs first', () => {
  it('texts the filter rejects are never counted, even with k companies agreeing', () => {
    const ids = companies(6);
    for (const text of ['J SMITH', 'SALARY OCT', 'PAYMENT 8001015009087', 'TRANSFER TO SAVINGS', 'MR NDLOVU']) {
      const r = aggregatePool(ids.map((c) => obs(c, text, 'professional_fees')), all(ids));
      expect(r.rows).toEqual([]);
      expect(r.stats.rejectedByFilter).toBe(6);
    }
  });

  it('different raw texts of one merchant pool together under the filtered key', () => {
    const ids = companies(5);
    const texts = ['ENGEN SANDTON 0412', 'POS ENGEN DURBAN', 'Engen Midrand', 'ENGEN 1-STOP', 'engen garage'];
    const r = aggregatePool(ids.map((c, i) => obs(c, texts[i]!, 'fuel')), all(ids));
    expect(r.rows.map((x) => x.merchant)).toEqual(['ENGEN']);
  });

  it('a published row carries only merchant, category and counts', () => {
    const ids = companies(5);
    const r = aggregatePool(ids.map((c) => obs(c, 'TAKEALOT', 'stationery')), all(ids));
    expect(Object.keys(r.rows[0]!).sort()).toEqual(['agreement', 'category', 'companies', 'merchant', 'observations']);
    expect(JSON.stringify(r.rows)).not.toMatch(/0000-4000/);
  });
});

describe('accountToCategory', () => {
  it('maps each account to its one category; an account two categories map to is left out', () => {
    const m = accountToCategory([
      { categoryCode: 'fuel', glAccountId: 'A' },
      { categoryCode: 'telephone', glAccountId: 'B' },
      { categoryCode: 'internet', glAccountId: 'B' },
    ]);
    expect([...m.entries()]).toEqual([['a', 'fuel']]);
  });
});

describe('aggregatePool — the pool never votes for itself', () => {
  const withOrigin = (o: PoolObservation, origin: PoolObservation['origin']): PoolObservation => ({ ...o, origin });

  it('a company that accepted the pool suggestion for a merchant gives no vote through its learned pattern', () => {
    // 4 companies coded ESKOM themselves; a 5th only took the pool's word (the accepted line, plus the
    // learned pattern that acceptance wrote). 4 independent votes: not published.
    const ids = companies(5);
    const o = ids.slice(0, 4).map((c) => obs(c, 'ESKOM PREPAID', 'electricity'));
    o.push(withOrigin(obs(ids[4]!, 'ESKOM PREPAID 0412345678901', 'electricity'), 'pool_accepted'));
    o.push(obs(ids[4]!, 'ESKOM PREPAID', 'electricity'));
    const r = aggregatePool(o, all(ids));
    expect(r.rows).toEqual([]);
    expect(r.stats.poolEchoDropped).toBe(2);
  });

  it('a recoded decision on that merchant is the company\'s own judgement and still votes', () => {
    const ids = companies(5);
    const o = ids.slice(0, 4).map((c) => obs(c, 'ESKOM PREPAID', 'electricity'));
    o.push(withOrigin(obs(ids[4]!, 'ESKOM PREPAID', 'electricity'), 'pool_accepted'));
    o.push(withOrigin(obs(ids[4]!, 'ESKOM PREPAID', 'electricity'), 'recoded'));
    expect(aggregatePool(o, all(ids)).rows).toEqual([
      { merchant: 'ESKOM', category: 'electricity', companies: 5, agreement: 1, observations: 5 },
    ]);
  });

  it('mutes only that merchant, for only that company', () => {
    const ids = companies(5);
    const o = ids.map((c) => obs(c, 'VODACOM', 'telephone'));
    o.push(withOrigin(obs(ids[0]!, 'ESKOM', 'electricity'), 'pool_accepted'));
    expect(aggregatePool(o, all(ids)).rows.map((r) => r.merchant)).toEqual(['VODACOM']);
  });
});
