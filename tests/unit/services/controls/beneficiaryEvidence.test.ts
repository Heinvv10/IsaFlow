import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, expect, it, vi } from 'vitest';
import { validateEvidence, assertPoliciesSupported } from '@/modules/accounting/services/controls/beneficiaryQueries';
import { requireControlTx, withControlRequest } from '@/modules/accounting/services/controls/context';
import type { EvidenceRef } from '@/modules/accounting/services/controls/contracts';
const companyId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const bytes = Buffer.from('synthetic documentary evidence');
const hash = createHash('sha256').update(bytes).digest('hex');
const evidence: EvidenceRef = { store: 'captured', evidenceId: id, entityType: 'supplier_invoice', entityId: id, hash, version: null };
const query = vi.fn(), client = { query } as unknown as PoolClient;
function check(refs: EvidenceRef[], entityType: 'supplier' | 'employee' = 'supplier') {
  return withControlRequest({ client, userId: 'u1', companyId, claims: {} }, { personId: 'u1', companyId, authMethod: 'cookie' },
    () => validateEvidence(requireControlTx(), { entityType, entityId: id }, refs));
}
beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [{ raw_bytes: bytes, raw_bytes_sha256: hash }] }); });
it('requires exact retrievable bytes and supplier parent ownership', async () => {
  expect(await check([evidence])).toEqual([evidence]);
  const sql = query.mock.calls[0]![0] as string;
  expect(sql).toContain('i.supplier_id='); expect(sql).toContain('i.company_id=d.company_id');
  query.mockResolvedValue({ rows: [] });
  await expect(check([evidence])).rejects.toThrow('EVIDENCE_UNAVAILABLE');
});
it('rejects mismatched bytes even when claimed and stored hashes agree', async () => {
  query.mockResolvedValue({ rows: [{ raw_bytes: Buffer.from('changed'), raw_bytes_sha256: hash }] });
  await expect(check([evidence])).rejects.toThrow('EVIDENCE_UNAVAILABLE_OR_CHANGED');
});
it('refuses absent, duplicate, unsupported-store and mismatched employee-parent evidence explicitly', async () => {
  await expect(check([])).rejects.toThrow('EVIDENCE_REQUIRED');
  await expect(check([evidence,evidence])).rejects.toThrow('INVALID_EVIDENCE');
  await expect(check([{ ...evidence,store:'procurement' }])).rejects.toThrow('EVIDENCE_STORE_UNSUPPORTED');
  await expect(check([evidence],'employee')).rejects.toThrow('INVALID_EVIDENCE');
});

it('locks the policy namespace before reading even an empty configured population', async () => {
  query.mockResolvedValue({ rows: [] });
  await withControlRequest({ client, userId: 'u1', companyId, claims: {} }, { personId: 'u1', companyId, authMethod: 'cookie' },
    () => assertPoliciesSupported(requireControlTx()));
  expect(query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock');
  expect(query.mock.calls[0]![1]).toContain(`control-policy:${companyId}`);
  expect(query.mock.calls[1]![0]).toContain('FROM approval_rules');
});
