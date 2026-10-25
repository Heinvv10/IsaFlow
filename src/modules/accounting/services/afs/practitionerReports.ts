// src/modules/accounting/services/afs/practitionerReports.ts
// Practitioner report wording: ISRS 4410 compilation, s58 accounting officer, ISRE 2400 review, ISA 700 audit.
// Based on AFS Master v15 — ISRS 4410, ISRE 2400, ISA 700, Companies Act 71 of 2008

import {
  capitalise, endedPhrase, entityLabel, entityLeadership, frameworkLabel, frameworkShort, thenNoun,
  type ReportTemplateContext,
} from './reportTemplateShared';

// ── 1. Compilation Report — ISRS 4410 (Revised) ─────────────────────────────

export function getCompilationReport(ctx: ReportTemplateContext): string[] {
  const thenWord = thenNoun(ctx);
  const leadership = entityLeadership(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  return [
    `INDEPENDENT PRACTITIONER'S COMPILATION REPORT`,
    ``,
    `To the ${leadership} of ${ctx.companyName}`,
    ``,
    `We have compiled the accompanying financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''} set out on pages {pageFrom} to {pageTo}, based on information you have provided. These financial statements comprise the statement of financial position as at ${ctx.periodEnd}, the statement of comprehensive income, statement of changes in equity and statement of cash flows for the ${thenWord} then ended, and a summary of significant accounting policies and other explanatory notes.`,
    ``,
    `We performed this compilation engagement in accordance with International Standard on Related Services 4410 (Revised), Compilation Engagements.`,
    ``,
    `We have applied our expertise in accounting and financial reporting to assist you in the preparation and presentation of these financial statements in accordance with the ${fw} (${fwShort}) and the requirements of the Companies Act 71 of 2008. We have complied with relevant ethical requirements, including principles of integrity, objectivity, professional competence and due care.`,
    ``,
    `These financial statements and the accuracy and completeness of the information used to compile them are your responsibility.`,
    ``,
    `Since a compilation engagement is not an assurance engagement, we are not required to verify the accuracy or completeness of the information you provided to us to compile these financial statements. Accordingly, we do not express an audit opinion or a review conclusion on whether these financial statements are prepared, in all material respects, in accordance with ${fwShort}.`,
    ``,
    ctx.practitionerName ?? '{practitionerName}',
    ctx.practitionerCity ?? '{practitionerCity}',
    ctx.reportDate ?? '{reportDate}',
  ];
}

// ── 2. Accounting Officer Report — s58 Close Corporations Act ────────────────

export function getAccountingOfficerReport(ctx: ReportTemplateContext): string[] {
  return [
    `REPORT OF THE ACCOUNTING OFFICER`,
    ``,
    `To the members of ${ctx.companyName}`,
    ``,
    `I have performed the duties of an accounting officer for the close corporation for the ${endedPhrase(ctx)} as required by section 62 of the Close Corporations Act, 1984.`,
    ``,
    `I confirm that the annual financial statements set out on pages {pageFrom} to {pageTo} are consistent with the accounting records of the close corporation and have been prepared in accordance with the ${frameworkLabel(ctx.framework)} and the Close Corporations Act, 1984.`,
    ``,
    `However, I have not performed an audit or review of these financial statements, and accordingly express no assurance thereon.`,
    ``,
    ctx.practitionerName ?? '{practitionerName}',
    `Accounting Officer`,
    ctx.practitionerCity ?? '{practitionerCity}',
    ctx.reportDate ?? '{reportDate}',
  ];
}

// ── 3. Independent Review Report — ISRE 2400 (Revised) ──────────────────────

export function getReviewReport(ctx: ReportTemplateContext): string[] {
  const thenWord = thenNoun(ctx);
  const leadership = entityLeadership(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  return [
    `INDEPENDENT REVIEWER'S REPORT`,
    ``,
    `To the ${leadership} of ${ctx.companyName}`,
    ``,
    `We have reviewed the accompanying financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''}, set out on pages {pageFrom} to {pageTo}, which comprise the statement of financial position as at ${ctx.periodEnd}, the statement of comprehensive income, the statement of changes in equity and the statement of cash flows for the ${thenWord} then ended, and a summary of significant accounting policies and other explanatory information.`,
    ``,
    `${capitalise(leadership)}' Responsibility for the Financial Statements`,
    ``,
    `The ${leadership} are responsible for the preparation and fair presentation of these financial statements in accordance with the ${fw} (${fwShort}) and the requirements of the Companies Act 71 of 2008, and for such internal control as the ${leadership} determine is necessary to enable the preparation of financial statements that are free from material misstatement, whether due to fraud or error.`,
    ``,
    `Reviewer's Responsibility`,
    ``,
    `Our responsibility is to express a conclusion on these financial statements. We conducted our review in accordance with International Standard on Review Engagements (ISRE) 2400 (Revised), Engagements to Review Historical Financial Statements. ISRE 2400 (Revised) requires us to conclude whether anything has come to our attention that causes us to believe that the financial statements, taken as a whole, are not prepared in all material respects in accordance with the applicable financial reporting framework.`,
    ``,
    `ISRE 2400 (Revised) also requires us to comply with relevant ethical requirements.`,
    ``,
    `A review of financial statements in accordance with ISRE 2400 (Revised) is a limited assurance engagement. We perform procedures, primarily consisting of making inquiries of management and others within the entity, as appropriate, and applying analytical procedures, and evaluate the evidence obtained.`,
    ``,
    `The procedures performed in a review are substantially less in extent than, and differ in nature from, those performed in an audit conducted in accordance with International Standards on Auditing. Accordingly, we do not express an audit opinion on these financial statements.`,
    ``,
    `Conclusion`,
    ``,
    `Based on our review, nothing has come to our attention that causes us to believe that these financial statements do not present fairly, in all material respects, the financial position of ${ctx.companyName} as at ${ctx.periodEnd}, and its financial performance and cash flows for the ${thenWord} then ended in accordance with ${fwShort} and the requirements of the Companies Act 71 of 2008.`,
    ``,
    ctx.practitionerName ?? '{practitionerName}',
    `Registered Auditor`,
    ctx.practitionerCity ?? '{practitionerCity}',
    ctx.reportDate ?? '{reportDate}',
  ];
}

// ── 4. Audit Report — ISA 700 (Revised) ─────────────────────────────────────

export function getAuditReport(ctx: ReportTemplateContext): string[] {
  const thenWord = thenNoun(ctx);
  const leadership = entityLeadership(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  return [
    `INDEPENDENT AUDITOR'S REPORT`,
    ``,
    `To the ${leadership} of ${ctx.companyName}`,
    ``,
    `Opinion`,
    ``,
    `We have audited the financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''}, set out on pages {pageFrom} to {pageTo}, which comprise the statement of financial position as at ${ctx.periodEnd}, and the statement of comprehensive income, statement of changes in equity and statement of cash flows for the ${thenWord} then ended, and notes to the financial statements, including a summary of significant accounting policies.`,
    ``,
    `In our opinion, the financial statements present fairly, in all material respects, the financial position of ${ctx.companyName} as at ${ctx.periodEnd}, and its financial performance and cash flows for the ${thenWord} then ended in accordance with the ${fw} (${fwShort}) and the requirements of the Companies Act 71 of 2008.`,
    ``,
    `Basis for Opinion`,
    ``,
    `We conducted our audit in accordance with International Standards on Auditing (ISAs). Our responsibilities under those standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the ${entityLabel(ctx.entityType)} in accordance with the Independent Regulatory Board for Auditors' Code of Professional Conduct for Registered Auditors (IRBA Code) and other independence requirements applicable to performing audits of financial statements in South Africa. We have fulfilled our other ethical responsibilities in accordance with the IRBA Code and in accordance with other ethical requirements applicable to performing audits in South Africa.`,
    ``,
    `We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our opinion.`,
    ``,
    `Responsibilities of the ${capitalise(leadership)} for the Financial Statements`,
    ``,
    `The ${leadership} are responsible for the preparation and fair presentation of the financial statements in accordance with ${fwShort} and the requirements of the Companies Act 71 of 2008, and for such internal control as the ${leadership} determine is necessary to enable the preparation of financial statements that are free from material misstatement, whether due to fraud or error.`,
    ``,
    `In preparing the financial statements, the ${leadership} are responsible for assessing the ${entityLabel(ctx.entityType)}'s ability to continue as a going concern, disclosing, as applicable, matters related to going concern and using the going concern basis of accounting unless the ${leadership} either intend to liquidate the ${entityLabel(ctx.entityType)} or to cease operations, or have no realistic alternative but to do so.`,
    ``,
    `Auditor's Responsibilities for the Audit of the Financial Statements`,
    ``,
    `Our objectives are to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatement, whether due to fraud or error, and to issue an auditor's report that includes our opinion. Reasonable assurance is a high level of assurance, but is not a guarantee that an audit conducted in accordance with ISAs will always detect a material misstatement when it exists. Misstatements can arise from fraud or error and are considered material if, individually or in the aggregate, they could reasonably be expected to influence the economic decisions of users taken on the basis of these financial statements.`,
    ``,
    ctx.practitionerName ?? '{practitionerName}',
    `Registered Auditor`,
    ctx.practitionerCity ?? '{practitionerCity}',
    ctx.reportDate ?? '{reportDate}',
  ];
}

// ── Report type selector ─────────────────────────────────────────────────────

export type ReportType = 'compilation' | 'accounting_officer' | 'review' | 'audit';

/**
 * Get the appropriate practitioner report based on PIS-determined reporting requirement.
 */
export function getPractitionerReport(reportType: ReportType, ctx: ReportTemplateContext): string[] {
  switch (reportType) {
    case 'compilation': return getCompilationReport(ctx);
    case 'accounting_officer': return getAccountingOfficerReport(ctx);
    case 'review': return getReviewReport(ctx);
    case 'audit': return getAuditReport(ctx);
  }
}
