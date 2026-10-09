/**
 * Approval Enforcement API (R-035)
 * GET  — this company's enforced document types and which types may be enabled;
 *        with `?preview=1`, also per enforceable type how many unposted documents
 *        it holds now (`preview` — computed on demand, it hashes every such bill)
 * POST — { documentType, enabled } switch enforcement on or off for one type
 *
 * Both GETs carry `legacyCreditNoteRules`: the company's ACTIVE rules of the
 * legacy `credit_note` type, which govern neither credit-note type (R-035 PR3),
 * `legacyPaymentRules`: those of the legacy `payment` type, which govern
 * neither payment type (R-035 PR5), and `legacyJournalRules`: those of the
 * legacy `journal_entry` type, which govern no journal (R-035 PR6).
 *
 * `supplier_bank_details` (forensic-controls step 1) shares the switchboard: its
 * preview is the suppliers with bank details unverified now (or, off, those
 * switching on would accept as the baseline for this viewer). Switching it on records that
 * baseline and is refused 403 to an impersonated session or a role below the
 * verifier role (SupplierBankVerificationError, nothing written).
 *
 * `bank_rule` (forensic-controls step 2) likewise: switching it on or off needs
 * a person in their own session (BankControlError 403 otherwise); on, the role
 * that approves bank-rule changes; off, the authority to weaken it.
 *
 * Enabling a type not in ENFORCEABLE_TYPES is a 400 NOT_ENFORCEABLE
 * (every type in PR1). Disabling needs the authority to WEAKEN the strictest
 * active rule of the type (mayWeakenAtLevel, R-048: a rank strictly above it,
 * or the owner at owner level); otherwise 403 RULE_AUTHORITY_REQUIRED. Both
 * writes are audited.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withSavepoint } from '@/lib/neon';
import type { EnforcementType } from '@/modules/accounting/services/gl/approvalRuleOptions';
import type { RuleActor } from '@/modules/accounting/services/gl/approvalRuleGuards';
import {
  ApprovalEnforcementAuthorityError, ApprovalEnforcementUnavailableError, ENFORCEABLE_TYPES,
  countLegacyCreditNoteRules, countLegacyJournalRules, countLegacyPaymentRules, disableEnforcement, enableEnforcement,
  listEnforcement,
} from '@/modules/accounting/services/gl/approvalEnforcement';
import { previewEnforcement } from '@/modules/accounting/services/gl/approvalEnforcementPreview';
import { SupplierBankVerificationError } from '@/modules/accounting/services/ap/supplierBankBaseline';
import { bankDetailsPreview } from '@/modules/accounting/services/ap/supplierBankVerification';
import { BankControlError } from '@/modules/accounting/services/bank/bankControlRefusal';

const DOCUMENT_TYPES = new Set<EnforcementType>([
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note', 'customer_credit_note', 'supplier_credit_note',
  'supplier_payment', 'payment_batch', 'manual_journal', 'supplier_bank_details', 'bank_rule',
]);
const isDocumentType = (value: unknown): value is EnforcementType =>
  typeof value === 'string' && DOCUMENT_TYPES.has(value as EnforcementType);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  // Role and identity come from withAuth's company_users lookup, never the body.
  const actor: RuleActor = { userId: user.id, role: companyRole, email: user.email };

  if (req.method === 'GET') {
    const items = await listEnforcement(companyId);
    // Active legacy `credit_note` rules govern nothing (R-035 PR3): the switch warns about them.
    const legacyCreditNoteRules = await countLegacyCreditNoteRules(companyId);
    // …and active legacy `payment` rules govern neither payment type (R-035 PR5).
    const legacyPaymentRules = await countLegacyPaymentRules(companyId);
    // …and active legacy `journal_entry` rules govern no journal (R-035 PR6).
    const legacyJournalRules = await countLegacyJournalRules(companyId);
    const base = { items, enforceable: ENFORCEABLE_TYPES, legacyCreditNoteRules, legacyPaymentRules, legacyJournalRules };
    // Hashes every unposted bill: only on demand (the Enforce switch asks), never on the plain read.
    if (req.query.preview !== '1') return apiResponse.success(res, base);
    const preview = { ...(await previewEnforcement(companyId)), supplier_bank_details: await bankDetailsPreview(companyId, user.id) };
    return apiResponse.success(res, { ...base, preview });
  }

  if (req.method === 'POST') {
    const { documentType, enabled } = req.body ?? {};
    if (!isDocumentType(documentType)) return apiResponse.badRequest(res, 'Invalid documentType');
    if (typeof enabled !== 'boolean') return apiResponse.badRequest(res, 'enabled must be true or false');
    try {
      // Savepoint: a refusal is answered with a 4xx, which withAuth COMMITs.
      await withSavepoint('approval_enforcement_write', () => (enabled
        ? enableEnforcement(companyId, documentType, actor)
        : disableEnforcement(companyId, documentType, actor)));
    } catch (error) {
      if (error instanceof ApprovalEnforcementUnavailableError) {
        return apiResponse.badRequest(res, error.message, { reason: error.code });
      }
      if (error instanceof ApprovalEnforcementAuthorityError || error instanceof SupplierBankVerificationError
        || error instanceof BankControlError) {
        return apiResponse.error(res, ErrorCode.FORBIDDEN, error.message, { reason: error.code });
      }
      throw error;
    }
    return apiResponse.success(res, { documentType, enabled });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
