/**
 * Dimensions Phase 1 — FNO derivation (brief §5.4) and conflict blocking (§5.5).
 *
 * A CC2 (project) sets its CC1 (FNO) by walking parent_id; an explicit CC1 that
 * disagrees is refused, never resolved either way. On revenue the FNO comes
 * from the customer, and a project under another FNO is refused.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  applyCustomerFno, applyFnoDerivation, deriveFnoId, deriveLineDimensions, deriveRevenueDimensions,
  type CostCentreNode,
} from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const FIBERTIME = 'aaaaaaaa-0000-4000-8000-000000000001';
const HEROTEL = 'aaaaaaaa-0000-4000-8000-000000000002';
const PROGRAMME = 'bbbbbbbb-0000-4000-8000-000000000001';
const LAWLEY = 'cccccccc-0000-4000-8000-000000000001';
const BEN_FARMS = 'cccccccc-0000-4000-8000-000000000002';
const ORPHAN = 'cccccccc-0000-4000-8000-000000000003';

const node = (id: string, code: string, parentId: string | null, ccType: string): [string, CostCentreNode] =>
  [id, { id, code, parentId, ccType }];
const NODES = new Map<string, CostCentreNode>([
  node(FIBERTIME, 'FIBERTIME', null, 'cc1'),
  node(HEROTEL, 'HEROTEL', null, 'cc1'),
  node(PROGRAMME, 'PHALABORWA', FIBERTIME, 'cc2'),
  node(LAWLEY, 'LAWLEY', FIBERTIME, 'cc2'),
  node(BEN_FARMS, 'BEN-FARMS', PROGRAMME, 'cc2'),
  node(ORPHAN, 'ORPHAN', null, 'cc2'),
]);

describe('deriveFnoId', () => {
  it('reads the FNO straight off a project whose parent is the CC1', () => {
    expect(deriveFnoId(LAWLEY, NODES)).toBe(FIBERTIME);
  });
  it('walks through a programme CC2 to the CC1 (Ben Farms -> Phalaborwa -> Fibertime)', () => {
    expect(deriveFnoId(BEN_FARMS, NODES)).toBe(FIBERTIME);
  });
  it('is null for a project with no FNO ancestor', () => {
    expect(deriveFnoId(ORPHAN, NODES)).toBeNull();
  });
  it('is null, not a hang, on a parent cycle', () => {
    const cyclic = new Map<string, CostCentreNode>([
      node('x', 'X', 'y', 'cc2'), node('y', 'Y', 'x', 'cc2'),
    ]);
    expect(deriveFnoId('x', cyclic)).toBeNull();
  });
});

describe('applyFnoDerivation', () => {
  it('fills CC1 from CC2 and leaves BU alone', () => {
    const [line] = applyFnoDerivation([{ cc2Id: BEN_FARMS, buId: 'bu-1' }], NODES);
    expect(line).toEqual({ cc2Id: BEN_FARMS, cc1Id: FIBERTIME, buId: 'bu-1' });
  });
  it('accepts an explicit CC1 that agrees', () => {
    expect(applyFnoDerivation([{ cc1Id: FIBERTIME, cc2Id: LAWLEY }], NODES)[0]!.cc1Id).toBe(FIBERTIME);
  });
  it('REFUSES an explicit CC1 that conflicts with the project, naming both codes', () => {
    let caught: unknown;
    try {
      applyFnoDerivation([{ cc1Id: HEROTEL, cc2Id: LAWLEY }], NODES, (i) => `lines[${i}]`);
    } catch (err) { caught = err; }
    expect(isDimensionRefusal(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/lines\[0\].*LAWLEY.*FIBERTIME.*HEROTEL/);
  });
  it('leaves a line without CC2 untouched', () => {
    const line = { cc1Id: HEROTEL };
    expect(applyFnoDerivation([line], NODES)[0]).toBe(line);
  });
});

describe('applyCustomerFno (revenue)', () => {
  it('defaults CC1 to the customer FNO', () => {
    expect(applyCustomerFno([{ buId: 'b' }], FIBERTIME)[0]).toEqual({ buId: 'b', cc1Id: FIBERTIME });
  });
  it('refuses a line whose FNO differs from the customer FNO', () => {
    expect(() => applyCustomerFno([{ cc1Id: HEROTEL }], FIBERTIME)).toThrow(/differs from the customer's FNO/);
  });
  it('changes nothing when the customer has no FNO', () => {
    expect(applyCustomerFno([{ cc1Id: HEROTEL }], null)).toEqual([{ cc1Id: HEROTEL }]);
  });
});

describe('deriveLineDimensions / deriveRevenueDimensions (queries)', () => {
  beforeEach(() => mockSql.mockReset());

  it('sends NO query when no line names a CC2', async () => {
    const out = await deriveLineDimensions(COMPANY, [{ cc1Id: FIBERTIME }, {}]);
    expect(out).toEqual([{ cc1Id: FIBERTIME }, {}]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('leaves a malformed CC2 for the line validator instead of casting it', async () => {
    // A non-UUID in the ::UUID[] cast is a raw Postgres error; skipping the
    // query leaves the line unchanged so validation refuses it by its slot.
    const out = await deriveLineDimensions(COMPANY, [{ cc2Id: 'not-a-uuid' }]);
    expect(out).toEqual([{ cc2Id: 'not-a-uuid' }]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('casts only the well-formed ids when a malformed one sits beside them', async () => {
    mockSql.mockResolvedValueOnce([
      { id: LAWLEY, code: 'LAWLEY', parent_id: FIBERTIME, cc_type: 'cc2' },
      { id: FIBERTIME, code: 'FIBERTIME', parent_id: null, cc_type: 'cc1' },
    ]);
    const out = await deriveLineDimensions(COMPANY, [{ cc2Id: LAWLEY }, { cc2Id: 'not-a-uuid' }]);
    expect(out[0]!.cc1Id).toBe(FIBERTIME);
    expect(out[1]).toEqual({ cc2Id: 'not-a-uuid' });
    expect(mockSql.mock.calls[0]!.slice(1)).not.toContainEqual(expect.arrayContaining(['not-a-uuid']));
  });

  it('loads the parent chain once, company-scoped, and derives', async () => {
    mockSql.mockResolvedValueOnce([
      { id: LAWLEY, code: 'LAWLEY', parent_id: FIBERTIME, cc_type: 'cc2' },
      { id: FIBERTIME, code: 'FIBERTIME', parent_id: null, cc_type: 'cc1' },
    ]);
    const out = await deriveLineDimensions(COMPANY, [{ cc2Id: LAWLEY }]);
    expect(out[0]!.cc1Id).toBe(FIBERTIME);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect((mockSql.mock.calls[0]![0] as string[]).join('?')).toMatch(/company_id = \?::UUID/);
  });

  it('a revenue line with a project under another FNO is refused against the customer', async () => {
    mockSql
      // chain for the CC2
      .mockResolvedValueOnce([
        { id: LAWLEY, code: 'LAWLEY', parent_id: FIBERTIME, cc_type: 'cc2' },
        { id: FIBERTIME, code: 'FIBERTIME', parent_id: null, cc_type: 'cc1' },
      ])
      // customers.default_cc1_id
      .mockResolvedValueOnce([{ fno: HEROTEL }])
      // codes for the message
      .mockResolvedValueOnce([
        { id: HEROTEL, code: 'HEROTEL', parent_id: null, cc_type: 'cc1' },
        { id: FIBERTIME, code: 'FIBERTIME', parent_id: null, cc_type: 'cc1' },
      ]);
    await expect(deriveRevenueDimensions(COMPANY, 'cust-1', [{ cc2Id: LAWLEY }]))
      .rejects.toThrow(/FNO FIBERTIME differs from the customer's FNO HEROTEL/);
  });

  it('a revenue line with no dimension stores the customer FNO, read in ONE query (it is no longer applied at posting)', async () => {
    mockSql.mockResolvedValueOnce([{ fno: HEROTEL }]);
    expect(await deriveRevenueDimensions(COMPANY, 'cust-1', [{}])).toEqual([{ cc1Id: HEROTEL.toLowerCase() }]);
    expect(mockSql).toHaveBeenCalledTimes(1);
    mockSql.mockResolvedValueOnce([{ fno: null }]);
    expect(await deriveRevenueDimensions(COMPANY, 'cust-1', [{}])).toEqual([{}]);
  });
});
