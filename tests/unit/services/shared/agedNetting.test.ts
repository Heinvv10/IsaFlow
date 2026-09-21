/**
 * RED — the shape of an aged row once on-account credit is netted.
 *
 * The buckets stay GROSS. `unapplied` is carried alongside as a NEGATIVE
 * figure, and `net` is the sum of the two. Reporting only the net would hide
 * the age of the debt; reporting only the gross is what made an aged total
 * overstate what an entity actually owes.
 *
 * An entity with credit and no open document still has to produce a row, or
 * the report's net total silently omits it.
 */
import { describe, it, expect } from 'vitest';
import { netAgingRows } from '@/modules/accounting/services/shared/agedNetting';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

function bucket(entityId: string, entityName: string, total: number): AgingBucket {
  return {
    entityId, entityName,
    current: total, days30: 0, days60: 0, days90: 0, days120Plus: 0, total,
  };
}

describe('netAgingRows', () => {
  it('leaves the buckets untouched and nets the entity total', () => {
    const [row] = netAgingRows(
      [bucket('e1', 'Acme', 1000)],
      new Map([['e1', { entityName: 'Acme', payments: 200, creditNotes: 115, total: 315 }]]),
    );
    expect(row!.current).toBe(1000);
    expect(row!.total).toBe(1000);
    expect(row!.unapplied).toBe(-315);
    expect(row!.net).toBe(685);
  });

  it('reports zero unapplied and a net equal to the gross when there is no credit', () => {
    const [row] = netAgingRows([bucket('e1', 'Acme', 1000)], new Map());
    expect(row!.unapplied).toBe(0);
    expect(row!.net).toBe(1000);
  });

  it('emits a row for an entity that has only unapplied credit', () => {
    const rows = netAgingRows([], new Map([['e2', { entityName: 'Beta', payments: 0, creditNotes: 500, total: 500 }]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe('e2');
    expect(rows[0]!.entityName).toBe('Beta');
    expect(rows[0]!.total).toBe(0);
    expect(rows[0]!.unapplied).toBe(-500);
    expect(rows[0]!.net).toBe(-500);
  });

  it('rounds the net to a cent rather than carrying float drift', () => {
    const [row] = netAgingRows(
      [bucket('e1', 'Acme', 0.1 + 0.2)],
      new Map([['e1', { entityName: 'Acme', payments: 0, creditNotes: 0.1, total: 0.1 }]]),
    );
    expect(row!.net).toBe(0.2);
  });
});
