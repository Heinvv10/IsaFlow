/**
 * Blind review r2 M2: a snapshot or check run is hashed under the document version IT was sealed with (its totals'
 * document_version), never the code's current DOCUMENT_VERSION — so bumping the constant cannot turn an earlier
 * seal invalid. Pinned against the canonical document spelled out by hand, under a version the code is not at.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@/modules/accounting/services/audit/canonical';
import { DOCUMENT_VERSION, checkRunHash, documentVersion, snapshotHash } from '@/modules/accounting/services/audit/documents';

const OTHER = DOCUMENT_VERSION + 5;

describe('the hashed document version is the stored one', () => {
  it('snapshotHash', () => {
    const totals = { document_version: OTHER, fy_start: '2026-01-01' };
    const h = { id: 'i', companyId: 'c', cutoff: '2026-06-30', takenAt: 't', takenBy: 'u', trigger: 'manual', caveat: 'x',
      masterDataHighWater: null, totals, checkRun: null };
    expect(snapshotHash(h, [], [], [])).toBe(sha256Hex(canonicalJson({
      kind: 'audit_snapshot', version: OTHER, id: 'i', company_id: 'c', cutoff: '2026-06-30', taken_at: 't', taken_by: 'u',
      trigger: 'manual', caveat: 'x', master_data_high_water: null, totals, check_run: null, trial_balance: [], journals: [], lines: [],
    })));
  });

  it('checkRunHash', () => {
    const totals = { document_version: OTHER, checks: 0 };
    const h = { id: 'r', companyId: 'c', asAt: '2026-06-30', periodStart: '2026-01-01', takenAt: 't', takenBy: 'u',
      purpose: 'standalone' as const, totals };
    expect(checkRunHash(h, [])).toBe(sha256Hex(canonicalJson({
      kind: 'audit_check_run', version: OTHER, id: 'r', company_id: 'c', as_at: '2026-06-30', period_start: '2026-01-01',
      taken_at: 't', taken_by: 'u', purpose: 'standalone', totals, results: [],
    })));
  });

  it('a document that records no version hashes as version null (it cannot match a seal made under one)', () => {
    expect([documentVersion({}), documentVersion({ document_version: '2' }), documentVersion({ document_version: 2.5 }),
      documentVersion({ document_version: 3 })]).toEqual([null, null, null, 3]);
  });
});
