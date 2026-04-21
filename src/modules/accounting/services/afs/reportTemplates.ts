// src/modules/accounting/services/afs/reportTemplates.ts
// SA Companies Act & IFRS-compliant report wording templates
// Based on AFS Master v15 — ISRS 4410, ISRE 2400, ISA 700, Companies Act 71 of 2008

// ── Template Data Context ────────────────────────────────────────────────────

export interface ReportTemplateContext {
  companyName: string;
  registrationNumber: string | null;
  /** e.g. "28 February 2026" */
  periodEnd: string;
  /** e.g. "1 March 2025" */
  periodStart: string;
  framework: 'ifrs_smes' | 'full_ifrs';
  /** Pty = Private Company, CC = Close Corporation, Trust */
  entityType: 'pty' | 'cc' | 'trust';
  /** Name of the accounting firm / practitioner */
  practitionerName?: string;
  /** City where the report is signed */
  practitionerCity?: string;
  /** Date the report is signed (ISO string) */
  reportDate?: string;
  /** Directors' names for the directors' report */
  directorNames?: string[];
  /** Registered address */
  registeredAddress?: string;
  /** Nature of business */
  natureOfBusiness?: string;
}

// ── Entity-type labels ───────────────────────────────────────────────────────

function entityLabel(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'close corporation';
    case 'trust': return 'trust';
    default: return 'company';
  }
}

function entityLeadership(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'members';
    case 'trust': return 'trustees';
    default: return 'directors';
  }
}

function entityLeadershipSingular(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'member';
    case 'trust': return 'trustee';
    default: return 'director';
  }
}

function frameworkLabel(framework: ReportTemplateContext['framework']): string {
  return framework === 'full_ifrs'
    ? 'International Financial Reporting Standards'
    : 'International Financial Reporting Standard for Small and Medium-sized Entities';
}

function frameworkShort(framework: ReportTemplateContext['framework']): string {
  return framework === 'full_ifrs' ? 'IFRS' : 'IFRS for SMEs';
}

// ── 1. Compilation Report — ISRS 4410 (Revised) ─────────────────────────────

export function getCompilationReport(ctx: ReportTemplateContext): string[] {
  const leadership = entityLeadership(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  return [
    `INDEPENDENT PRACTITIONER'S COMPILATION REPORT`,
    ``,
    `To the ${leadership} of ${ctx.companyName}`,
    ``,
    `We have compiled the accompanying financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''} set out on pages {pageFrom} to {pageTo}, based on information you have provided. These financial statements comprise the statement of financial position as at ${ctx.periodEnd}, the statement of comprehensive income, statement of changes in equity and statement of cash flows for the year then ended, and a summary of significant accounting policies and other explanatory notes.`,
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
    `I have performed the duties of an accounting officer for the close corporation for the year ended ${ctx.periodEnd} as required by section 62 of the Close Corporations Act, 1984.`,
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
  const leadership = entityLeadership(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  return [
    `INDEPENDENT REVIEWER'S REPORT`,
    ``,
    `To the ${leadership} of ${ctx.companyName}`,
    ``,
    `We have reviewed the accompanying financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''}, set out on pages {pageFrom} to {pageTo}, which comprise the statement of financial position as at ${ctx.periodEnd}, the statement of comprehensive income, the statement of changes in equity and the statement of cash flows for the year then ended, and a summary of significant accounting policies and other explanatory information.`,
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
    `Based on our review, nothing has come to our attention that causes us to believe that these financial statements do not present fairly, in all material respects, the financial position of ${ctx.companyName} as at ${ctx.periodEnd}, and its financial performance and cash flows for the year then ended in accordance with ${fwShort} and the requirements of the Companies Act 71 of 2008.`,
    ``,
    ctx.practitionerName ?? '{practitionerName}',
    `Registered Auditor`,
    ctx.practitionerCity ?? '{practitionerCity}',
    ctx.reportDate ?? '{reportDate}',
  ];
}

// ── 4. Audit Report — ISA 700 (Revised) ─────────────────────────────────────

export function getAuditReport(ctx: ReportTemplateContext): string[] {
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
    `We have audited the financial statements of ${ctx.companyName}${ctx.registrationNumber ? ` (Registration number: ${ctx.registrationNumber})` : ''}, set out on pages {pageFrom} to {pageTo}, which comprise the statement of financial position as at ${ctx.periodEnd}, and the statement of comprehensive income, statement of changes in equity and statement of cash flows for the year then ended, and notes to the financial statements, including a summary of significant accounting policies.`,
    ``,
    `In our opinion, the financial statements present fairly, in all material respects, the financial position of ${ctx.companyName} as at ${ctx.periodEnd}, and its financial performance and cash flows for the year then ended in accordance with the ${fw} (${fwShort}) and the requirements of the Companies Act 71 of 2008.`,
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

// ── 5. Directors' Responsibility Statement ───────────────────────────────────

export function getDirectorResponsibilityStatement(ctx: ReportTemplateContext): string[] {
  const leadership = entityLeadership(ctx.entityType);
  const leaderSingular = entityLeadershipSingular(ctx.entityType);
  const fw = frameworkLabel(ctx.framework);
  const fwShort = frameworkShort(ctx.framework);

  const paragraphs = [
    `RESPONSIBILITIES OF THE ${capitalise(leadership).toUpperCase()}`,
    ``,
    `The ${leadership} are required by the Companies Act 71 of 2008 to maintain adequate accounting records and are responsible for the content and integrity of the annual financial statements and related financial information included in this report. It is their responsibility to ensure that the annual financial statements fairly present the state of affairs of the ${entityLabel(ctx.entityType)} as at the end of the financial year and the results of its operations and cash flows for the period then ended, in conformity with the ${fw} (${fwShort}).`,
    ``,
    `The annual financial statements are prepared in accordance with ${fwShort} and are based upon appropriate accounting policies consistently applied and supported by reasonable and prudent judgements and estimates.`,
    ``,
    `The ${leadership} acknowledge that they are ultimately responsible for the system of internal financial control established by the ${entityLabel(ctx.entityType)} and place considerable importance on maintaining a strong control environment. To enable the ${leadership} to meet these responsibilities, the ${leadership} set standards for internal control aimed at reducing the risk of error or loss in a cost-effective manner. The standards include the proper delegation of responsibilities within a clearly defined framework, effective accounting procedures and adequate segregation of duties to ensure an acceptable level of risk.`,
    ``,
    `The ${leadership} are of the opinion, based on the information and explanations given by management, that the system of internal control provides reasonable assurance that the financial records may be relied on for the preparation of the annual financial statements. However, any system of internal financial control can provide only reasonable, and not absolute, assurance against material misstatement or loss.`,
    ``,
    `The ${leadership} have reviewed the ${entityLabel(ctx.entityType)}'s cash flow forecast for the year to ${ctx.periodEnd} and, in the light of this review and the current financial position, they are satisfied that the ${entityLabel(ctx.entityType)} has adequate resources to continue in operational existence for the foreseeable future.`,
    ``,
    `The annual financial statements set out on pages {pageFrom} to {pageTo}, which have been prepared on the going concern basis, were approved by the ${leadership} on ${ctx.reportDate ?? '{reportDate}'} and were signed on their behalf by:`,
  ];

  // Add director signature lines
  if (ctx.directorNames && ctx.directorNames.length > 0) {
    paragraphs.push('');
    for (const name of ctx.directorNames) {
      paragraphs.push(`_________________________`);
      paragraphs.push(`${capitalise(leaderSingular)}: ${name}`);
      paragraphs.push('');
    }
  } else {
    paragraphs.push('');
    paragraphs.push(`_________________________`);
    paragraphs.push(`${capitalise(leaderSingular)}`);
  }

  return paragraphs;
}

// ── 6. Directors' Report ─────────────────────────────────────────────────────

export function getDirectorsReport(ctx: ReportTemplateContext): string[] {
  const leadership = entityLeadership(ctx.entityType);
  const entity = entityLabel(ctx.entityType);

  const paragraphs = [
    `REPORT OF THE ${capitalise(leadership).toUpperCase()}`,
    ``,
    `The ${leadership} have pleasure in submitting their report on the annual financial statements of ${ctx.companyName} for the year ended ${ctx.periodEnd}.`,
    ``,
    `1. Nature of Business`,
    ``,
    ctx.natureOfBusiness
      ? `The ${entity} is engaged principally in ${ctx.natureOfBusiness}. There have been no material changes to the nature of the ${entity}'s business from the prior year.`
      : `[Accountant: describe the principal business activities of the ${entity}]`,
    ``,
    `2. Review of Financial Results and Activities`,
    ``,
    `The annual financial statements have been prepared in accordance with the ${frameworkLabel(ctx.framework)} (${frameworkShort(ctx.framework)}) and the requirements of the Companies Act 71 of 2008. The accounting policies have been applied consistently compared to the prior year.`,
    ``,
    `Full details of the financial position, results of operations and cash flows of the ${entity} are set out in these annual financial statements.`,
    ``,
    `3. ${capitalise(leadership)}`,
    ``,
  ];

  if (ctx.directorNames && ctx.directorNames.length > 0) {
    paragraphs.push(`The ${leadership} in office at the date of this report are:`);
    for (const name of ctx.directorNames) {
      paragraphs.push(`• ${name}`);
    }
  } else {
    paragraphs.push(`[Accountant: list the ${leadership} in office at the date of the report]`);
  }

  paragraphs.push('');
  paragraphs.push(`4. Events After the Reporting Period`);
  paragraphs.push('');
  paragraphs.push(`The ${leadership} are not aware of any material event which occurred after the reporting date and up to the date of this report. [Accountant: update if applicable]`);
  paragraphs.push('');
  paragraphs.push(`5. Going Concern`);
  paragraphs.push('');
  paragraphs.push(`The ${leadership} believe that the ${entity} has adequate financial resources to continue in operation for the foreseeable future and accordingly the annual financial statements have been prepared on a going concern basis. [Accountant: update if going concern issues exist]`);
  paragraphs.push('');

  if (ctx.registeredAddress) {
    paragraphs.push(`6. Registered Office`);
    paragraphs.push('');
    paragraphs.push(ctx.registeredAddress);
    paragraphs.push('');
  }

  return paragraphs;
}

// ── 7. Emphasis of Matter ────────────────────────────────────────────────────

export function getEmphasisOfMatter(noteRef: string, description: string): string[] {
  return [
    `Emphasis of Matter`,
    ``,
    `We draw attention to ${noteRef} to the financial statements, which describes ${description}. Our opinion is not modified in respect of this matter.`,
  ];
}

// ── 8. General Information Page ──────────────────────────────────────────────

export function getGeneralInformation(ctx: ReportTemplateContext): string[] {
  const leadership = entityLeadership(ctx.entityType);
  const lines = [
    `GENERAL INFORMATION`,
    ``,
    `Country of incorporation and domicile: South Africa`,
    ``,
  ];

  if (ctx.registrationNumber) {
    lines.push(`Registration number: ${ctx.registrationNumber}`);
    lines.push('');
  }

  if (ctx.natureOfBusiness) {
    lines.push(`Nature of business: ${ctx.natureOfBusiness}`);
    lines.push('');
  }

  if (ctx.directorNames && ctx.directorNames.length > 0) {
    lines.push(`${capitalise(leadership)}:`);
    for (const name of ctx.directorNames) {
      lines.push(`  ${name}`);
    }
    lines.push('');
  }

  if (ctx.registeredAddress) {
    lines.push(`Registered office: ${ctx.registeredAddress}`);
    lines.push('');
  }

  if (ctx.practitionerName) {
    lines.push(`Accountant / Auditor: ${ctx.practitionerName}`);
    lines.push('');
  }

  lines.push(`Financial year end: ${ctx.periodEnd}`);

  return lines;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
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
