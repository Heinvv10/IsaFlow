// tests/unit/components/groupUserCompanies.test.ts
//
// GET /api/accounting/companies?action=user-companies returns camelCase rows
// (`companyId` / `companyName` — see `CompanyUser` in companyMapper.ts), but
// pages/accounting/group/setup.tsx fed `await res.json()` — typed `any` —
// straight into `SimpleCompany[]` (`{ id, name }`).
//
// Every `c.id` and `c.name` was therefore `undefined`, and four render sites
// silently produced blank <option> elements:
//   GroupDetailsTab.tsx:36   add-member picker (availableCompanies filter)
//   GroupDetailsTab.tsx:99   Holding Company — create form
//   GroupDetailsTab.tsx:154  Holding Company — edit form
//   GroupCoaTab.tsx:118      source company for COA auto-generation
//
// The dropdowns showed the right NUMBER of entries with no labels and no
// values, which is why it read as a rendering quirk rather than a data bug.
// tsc could not catch it: the lie happened inside an untyped JSON parse.

import { describe, it, expect } from 'vitest';
import { toSimpleCompanies, type UserCompanyRow } from '@/components/accounting/group/types';

// Verbatim shape of a real production response for hein@brighttech.co.za.
const API_ROWS: UserCompanyRow[] = [
  { companyId: 'd27bac33-cdc0-4e58-bf6b-709c1597d41c', companyName: 'Brightsphere Technologies (Pty) Ltd', role: 'owner', isDefault: true },
  { companyId: 'd6184044-047a-4ae7-bc97-c9a3a136e66a', companyName: 'H10 Holdings (Pty) Ltd', role: 'owner', isDefault: false },
  { companyId: '4a159669-2f50-46b5-a7b8-2e94dab3d495', companyName: 'Velocity Fibre (Pty) Ltd', role: 'owner', isDefault: false },
];

describe('toSimpleCompanies', () => {
  it('maps companyId/companyName onto the id/name the pickers render', () => {
    expect(toSimpleCompanies(API_ROWS)).toEqual([
      { id: 'd27bac33-cdc0-4e58-bf6b-709c1597d41c', name: 'Brightsphere Technologies (Pty) Ltd' },
      { id: 'd6184044-047a-4ae7-bc97-c9a3a136e66a', name: 'H10 Holdings (Pty) Ltd' },
      { id: '4a159669-2f50-46b5-a7b8-2e94dab3d495', name: 'Velocity Fibre (Pty) Ltd' },
    ]);
  });

  it('produces no blank option: every entry has a non-empty id AND name', () => {
    const out = toSimpleCompanies(API_ROWS);
    expect(out).toHaveLength(3);
    for (const c of out) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
    }
  });

  it('is the exact regression: passing the rows through unmapped yields undefined fields', () => {
    // What the page used to do. Kept as a live demonstration so the failure mode
    // stays legible rather than becoming folklore in a comment.
    const unmapped = API_ROWS as unknown as Array<{ id?: string; name?: string }>;
    expect(unmapped.every(c => c.id === undefined && c.name === undefined)).toBe(true);
  });

  it('drops rows with no companyId rather than rendering a valueless option', () => {
    const rows = [...API_ROWS, { companyId: '', companyName: 'Broken' } as UserCompanyRow];
    expect(toSimpleCompanies(rows)).toHaveLength(3);
  });

  it('returns an empty list for an empty response', () => {
    expect(toSimpleCompanies([])).toEqual([]);
  });
});
