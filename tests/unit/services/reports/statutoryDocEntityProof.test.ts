/**
 * Compliance alerts name the registration document the company's ENTITY TYPE requires:
 * a CC its CK1/CK2, a trust its Letters of Authority, a (Pty) Ltd its CIPC certificate,
 * and a sole proprietor / partnership / "other" no registration document at all
 * (no "CIPC missing" alert for a business that has no CIPC registration).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ entityType: 'pty_ltd' as string | null, docs: [] as { document_type: string }[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM companies')) return Promise.resolve([{ entity_type: db.entityType }]);
    return Promise.resolve(db.docs.map(d => ({ ...d, document_name: `${d.document_type}.pdf`, extracted_data: null })));
  }),
}));

import { checkComplianceAlerts } from '@/modules/accounting/services/reports/statutoryDocService';

const missing = async () => (await checkComplianceAlerts('00000000-0000-4000-8000-000000000001'))
  .filter(a => a.status === 'missing').map(a => a.documentType);
const OPTIONAL = ['tax_clearance', 'bbee', 'vat_registration'];

beforeEach(() => { db.docs = []; });

describe('checkComplianceAlerts: the registration proof follows the entity type', () => {
  it('pty_ltd, ltd and npc need the CIPC certificate', async () => {
    for (const t of ['pty_ltd', 'ltd', 'npc']) { db.entityType = t; expect(await missing(), t).toEqual(['cipc', ...OPTIONAL]); }
  });
  it('a CC needs its CK1/CK2, and has it once uploaded', async () => {
    db.entityType = 'cc';
    expect(await missing()).toEqual(['ck_certificate', ...OPTIONAL]);
    db.docs = [{ document_type: 'ck_certificate' }];
    expect(await missing()).toEqual(OPTIONAL);
  });
  it("a trust needs the Master's Letters of Authority", async () => {
    db.entityType = 'trust';
    expect(await missing()).toEqual(['letters_of_authority', ...OPTIONAL]);
  });
  it('a sole proprietor, partnership or "other" gets no registration-document alert', async () => {
    for (const t of ['sole_proprietor', 'partnership', 'other']) { db.entityType = t; expect(await missing(), t).toEqual(OPTIONAL); }
  });
  it('a company with no entity type keeps the old CIPC alert (the column default)', async () => {
    db.entityType = null;
    expect(await missing()).toEqual(['cipc', ...OPTIONAL]);
  });
});
