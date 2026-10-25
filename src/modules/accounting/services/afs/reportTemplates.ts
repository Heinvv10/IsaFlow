// src/modules/accounting/services/afs/reportTemplates.ts
// SA Companies Act & IFRS-compliant report wording templates
// Based on AFS Master v15 — ISRS 4410, ISRE 2400, ISA 700, Companies Act 71 of 2008
// The context and wording helpers are in reportTemplateShared.ts, the practitioner reports in
// practitionerReports.ts; both are re-exported here so importers keep one path.

import {
  capitalise, endedPhrase, entityLabel, entityLeadership, entityLeadershipSingular, frameworkLabel, frameworkShort,
  type ReportTemplateContext,
} from './reportTemplateShared';

export type { ReportTemplateContext } from './reportTemplateShared';
export {
  getCompilationReport, getAccountingOfficerReport, getReviewReport, getAuditReport, getPractitionerReport,
  type ReportType,
} from './practitionerReports';

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
    `The ${leadership} have pleasure in submitting their report on the annual financial statements of ${ctx.companyName} for the ${endedPhrase(ctx)}.`,
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
