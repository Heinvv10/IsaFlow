// tests/integration/supplier-ownership-fence-satellites.int.test.ts
//
// R-068, the non-document write sites: every other route that stores a
// supplier id taken from the request (or the URL) in a column whose FK to
// `suppliers` is tenant-agnostic. Same contract as the document file: B's
// supplier is refused with a 4xx and leaves nothing behind; A's own is stored.
//
// `bank_categorisation_rules` is the one table whose FK already carries
// company_id, so the database itself refused B's supplier there — as a 23503
// the POST route answered 500. Its cases pin the typed 400 the fence gives.

import { describe, beforeAll, afterAll } from 'vitest';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  ids, setUpFixture, tearDownFixture, fenceCases, type Fixture, type SupplierCase,
} from './supplier-ownership-fence.helpers';
import supplierActivities from '../../pages/api/accounting/supplier-activities';
import supplierContacts from '../../pages/api/accounting/supplier-contacts';
import supplierRules from '../../pages/api/accounting/supplier-rules/index';
import supplierRuleDetail from '../../pages/api/accounting/supplier-rules/[supplierId]';
import supplierExpectations from '../../pages/api/accounting/supplier-expectations/index';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import adjustments from '../../pages/api/accounting/adjustments';
import bankRules from '../../pages/api/accounting/bank-rules';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

describeIfDb('R-068 — every satellite route refuses a foreign supplier id', () => {
  let fx: Fixture;
  const { A } = ids;
  const where = (table: string, column: string, extra = 'true', params: unknown[] = []) => (s: string) =>
    fx.count(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1 AND ${column} = $2 AND ${extra}`,
      [A, s, ...params]);

  const cases = (): SupplierCase[] => [
    { name: 'supplier-activities POST', handler: supplierActivities, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, activity_type: 'note', description: 'R068 note' }),
      carried: where('supplier_activities', 'supplier_id') },
    { name: 'supplier-contacts POST (primary — clears the old primary first)', handler: supplierContacts,
      method: 'POST', refusal: 400, body: (s) => ({ supplierId: s, fullName: 'R068 Contact', isPrimary: true }),
      carried: where('supplier_contacts', 'supplier_id') },
    { name: 'supplier-rules POST', handler: supplierRules, method: 'POST', refusal: 400,
      body: (s) => ({ supplierId: s, autoPublish: false }),
      carried: where('supplier_coding_rules', 'supplier_id') },
    { name: 'supplier-rules/[supplierId] PATCH', handler: supplierRuleDetail, method: 'PATCH', refusal: 400,
      query: (s) => ({ supplierId: s }), body: () => ({ defaultVatCode: 'R068P' }),
      carried: where('supplier_coding_rules', 'supplier_id', "default_vat_code = 'R068P'") },
    { name: 'supplier-expectations POST recompute', handler: supplierExpectations, method: 'POST',
      refusal: 400, query: () => ({ action: 'recompute' }), body: (s) => ({ supplierId: s }),
      carried: where('supplier_expectations', 'supplier_id') },
    { name: 'bank-transactions-action save_selection (supplier)', handler: bankTransactionsAction,
      method: 'POST', refusal: 400,
      body: (s) => ({ action: 'save_selection', bankTransactionId: ids.BANK_TX_SEL, selectionType: 'supplier',
        selectionEntityId: s }),
      carried: where('bank_transactions', 'suggested_supplier_id', 'id = $3', [ids.BANK_TX_SEL]) },
    { name: 'adjustments POST (supplier)', handler: adjustments, method: 'POST', refusal: 400,
      body: (s) => ({ entityType: 'supplier', entityId: s, adjustmentType: 'debit', amount: 50, reason: 'R068' }),
      carried: where('accounting_adjustments', 'entity_id', "entity_type = 'supplier'") },
    { name: 'bank-rules POST', handler: bankRules, method: 'POST', refusal: 400,
      body: (s) => ({ ruleName: 'R068 rule', matchField: 'description', matchType: 'contains',
        matchPattern: 'R068-NEW', supplierId: s }),
      carried: where('bank_categorisation_rules', 'supplier_id', "match_pattern = 'R068-NEW'") },
    { name: 'bank-rules-action update', handler: bankRulesAction, method: 'POST', refusal: 400,
      body: (s) => ({ action: 'update', id: ids.RULE, supplierId: s }),
      carried: where('bank_categorisation_rules', 'supplier_id', 'id = $3', [ids.RULE]) },
  ];

  beforeAll(async () => {
    assertDisposable();
    fx = await setUpFixture('R068 sat');
  });
  afterAll(() => tearDownFixture(fx?.pool));

  fenceCases(() => fx, cases);
});
