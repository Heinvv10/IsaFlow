// src/modules/accounting/services/afs/complianceCheckerService.ts
// IFRS compliance checker — structural, mathematical, and disclosure quality checks.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ComplianceResult, ComplianceIssue } from './afsTypes';

// ── Internal row types ────────────────────────────────────────────────────────

interface AfsDocRow {
  id: string;
  company_id: string;
  fiscal_year: number | null;
  reporting_framework: string;
  status: string;
}

type SectionContent = {
  title?: string;
  blocks?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

interface AfsSectionRow {
  id: string;
  document_id: string;
  company_id: string;
  section_type: string;
  sort_order: number;
  status: string;
  data_snapshot: Record<string, unknown> | null;
  content: SectionContent | null;
  overrides: Record<string, unknown> | null;
}

interface NoteTemplateRow {
  id: string;
  section_type: string;
  framework: string;
  title: string;
  is_mandatory: boolean;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchDocumentSections(
  companyId: string,
  documentId: string
): Promise<{ doc: AfsDocRow; sections: AfsSectionRow[]; templates: NoteTemplateRow[] }> {
  const [docRows, sectionRows, templateRows] = await Promise.all([
    sql`
      SELECT id, company_id, fiscal_year, reporting_framework, status
      FROM afs_documents
      WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    `,
    sql`
      SELECT id, document_id, company_id, section_type, sort_order,
             status, data_snapshot, content, overrides
      FROM afs_sections
      WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
    `,
    sql`SELECT id, section_type, framework, title, is_mandatory FROM note_templates`,
  ]);

  if (docRows.length === 0) {
    throw new Error(`AFS document ${documentId} not found for company ${companyId}`);
  }

  return {
    doc: docRows[0] as AfsDocRow,
    sections: sectionRows as AfsSectionRow[],
    templates: templateRows as NoteTemplateRow[],
  };
}

function computeScore(issues: ComplianceIssue[], totalChecks: number): number {
  let deductions = 0;
  for (const issue of issues) {
    if (issue.severity === 'blocker') deductions += 1;
    else if (issue.severity === 'warning') deductions += 0.5;
  }
  return Math.round((Math.max(0, totalChecks - deductions) / totalChecks) * 100);
}

// ── Structural Checks ─────────────────────────────────────────────────────────

function runStructuralChecks(
  doc: AfsDocRow,
  sections: AfsSectionRow[],
  templates: NoteTemplateRow[]
): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const fw = doc.reporting_framework;
  const mandatory = templates.filter(t => t.is_mandatory && (t.framework === fw || t.framework === 'both'));
  const presentTypes = new Set(sections.map(s => s.section_type));

  const missing = mandatory.filter(t => !presentTypes.has(t.section_type));
  if (missing.length > 0) {
    issues.push({
      checkId: 'structural.mandatory_notes_present',
      category: 'structural', severity: 'blocker',
      message: `${missing.length} mandatory note(s) missing: ${missing.map(t => t.section_type).join(', ')}`,
    });
  }

  const pendingMandatory = sections.filter(
    s => mandatory.some(t => t.section_type === s.section_type) && s.status === 'pending'
  );
  if (pendingMandatory.length > 0) {
    issues.push({
      checkId: 'structural.no_mandatory_note_pending',
      category: 'structural', severity: 'blocker',
      message: `${pendingMandatory.length} mandatory note(s) still pending: ${pendingMandatory.map(s => s.section_type).join(', ')}`,
    });
  }

  if (!presentTypes.has('directors_report')) {
    issues.push({
      checkId: 'structural.directors_report_present',
      category: 'structural', severity: 'blocker',
      message: 'Directors report is missing from this document',
      sectionType: 'directors_report',
    });
  }

  if (!presentTypes.has('note_24')) {
    issues.push({
      checkId: 'structural.auditors_remuneration_present',
      category: 'structural', severity: 'blocker',
      message: 'Note 24 (Auditors remuneration) is missing — required regardless of framework',
      sectionType: 'note_24',
    });
  }

  const statementTypes = ['statement_of_fp', 'income_statement', 'cash_flow', 'changes_in_equity'];
  const missingComparatives = sections.filter(
    s => statementTypes.includes(s.section_type) && s.content != null && !s.content.comparativePeriod
  );
  if (missingComparatives.length > 0) {
    issues.push({
      checkId: 'structural.comparative_figures_present',
      category: 'structural', severity: 'warning',
      message: `Comparative period missing from: ${missingComparatives.map(s => s.section_type).join(', ')}`,
      detail: 'Each primary statement must include prior-year comparative figures per IAS 1',
    });
  }

  return issues;
}

// ── Mathematical Checks ───────────────────────────────────────────────────────

function runMathematicalChecks(sections: AfsSectionRow[]): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const byType = (t: string) => sections.find(s => s.section_type === t);
  const sfp = byType('statement_of_fp');
  const cashFlow = byType('cash_flow');
  const equity = byType('changes_in_equity');
  const note17 = byType('note_17');

  if (sfp?.data_snapshot) {
    const totals = sfp.data_snapshot.totals as Record<string, unknown> | undefined;
    if (totals) {
      const diff = Number(totals.totalAssets ?? 0) - Number(totals.totalLiabilities ?? 0) - Number(totals.totalEquity ?? 0);
      if (Math.abs(diff) > 0.01) {
        issues.push({
          checkId: 'mathematical.balance_sheet_balances', category: 'mathematical', severity: 'blocker',
          message: 'Balance sheet does not balance: Assets ≠ Liabilities + Equity',
          sectionType: 'statement_of_fp', detail: `Gap: ${diff}`,
        });
      }
    }
  }

  if (cashFlow?.status === 'pending') {
    issues.push({ checkId: 'mathematical.cash_flow_closing_balance', category: 'mathematical', severity: 'info', message: 'Section not yet generated — check deferred', sectionType: 'cash_flow' });
  } else if (cashFlow?.data_snapshot && sfp?.data_snapshot) {
    const cfClose = Number(cashFlow.data_snapshot.closingBalance ?? NaN);
    const sfpCash = Number(sfp.data_snapshot.cashAccountBalance ?? NaN);
    if (!isNaN(cfClose) && !isNaN(sfpCash) && Math.abs(cfClose - sfpCash) > 0.01) {
      issues.push({ checkId: 'mathematical.cash_flow_closing_balance', category: 'mathematical', severity: 'blocker', message: 'Cash flow closing balance does not match balance sheet cash', sectionType: 'cash_flow', detail: `CF: ${cfClose}, BS: ${sfpCash}` });
    }
  }

  if (equity?.status === 'pending') {
    issues.push({ checkId: 'mathematical.equity_closing_balance', category: 'mathematical', severity: 'info', message: 'Section not yet generated — check deferred', sectionType: 'changes_in_equity' });
  } else if (equity?.data_snapshot && sfp?.data_snapshot) {
    const eqClose = Number(equity.data_snapshot.closingTotalEquity ?? NaN);
    const totals = sfp.data_snapshot.totals as Record<string, unknown> | undefined;
    const sfpEq = Number(totals?.totalEquity ?? NaN);
    if (!isNaN(eqClose) && !isNaN(sfpEq) && Math.abs(eqClose - sfpEq) > 0.01) {
      issues.push({ checkId: 'mathematical.equity_closing_balance', category: 'mathematical', severity: 'blocker', message: 'Equity statement closing does not match balance sheet equity', sectionType: 'changes_in_equity', detail: `Equity stmt: ${eqClose}, BS: ${sfpEq}` });
    }
  }

  if (note17?.data_snapshot) {
    const tax = Number(note17.data_snapshot.taxExpense ?? NaN);
    const pbt = Number(note17.data_snapshot.profitBeforeTax ?? NaN);
    if (!isNaN(tax) && !isNaN(pbt) && pbt !== 0) {
      const rate = tax / pbt;
      if (rate > 0.35 || rate < 0) {
        issues.push({ checkId: 'mathematical.income_tax_effective_rate', category: 'mathematical', severity: 'warning', message: 'Income tax effective rate is outside normal range (0%–35%)', sectionType: 'note_17', detail: `Effective rate: ${Math.round(rate * 10000) / 100}%` });
      }
    }
  }

  return issues;
}

// ── Disclosure Quality Checks ─────────────────────────────────────────────────

function runDisclosureQualityChecks(sections: AfsSectionRow[]): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const byType = (t: string) => sections.find(s => s.section_type === t);

  const sfp = byType('statement_of_fp');
  const note1 = byType('note_1');
  const directors = byType('directors_report');
  const note23 = byType('note_23');
  const note26 = byType('note_26');
  const note27 = byType('note_27');
  const income = byType('income_statement');

  if (sfp?.data_snapshot && note1?.content?.blocks) {
    const text = note1.content.blocks.map(b => b.text ?? '').join(' ').toLowerCase();
    const missingKw = ['revenue', 'ppe', 'inventory'].filter(kw => !text.includes(kw));
    if (missingKw.length > 0) {
      issues.push({ checkId: 'disclosure.note1_covers_material_types', category: 'disclosure_quality', severity: 'warning', message: `Note 1 missing coverage for: ${missingKw.join(', ')}`, sectionType: 'note_1' });
    }
  }

  if (directors?.content?.blocks) {
    const dirNames = directors.content.blocks.filter(b => b.text).map(b => b.text!.toLowerCase());
    if (!note23) {
      issues.push({ checkId: 'disclosure.note23_covers_directors', category: 'disclosure_quality', severity: 'blocker', message: 'Note 23 (Directors) is missing', sectionType: 'note_23' });
    } else if (note23.content?.blocks && dirNames.length > 0) {
      const n23Text = note23.content.blocks.map(b => b.text ?? '').join(' ').toLowerCase();
      if (dirNames.some(name => !n23Text.includes(name))) {
        issues.push({ checkId: 'disclosure.note23_covers_directors', category: 'disclosure_quality', severity: 'warning', message: 'Note 23 does not mention all directors from the directors report', sectionType: 'note_23' });
      }
    }
  }

  const note26Valid = note26 &&
    ((note26.content?.blocks?.some(b => b.text && b.text.trim() !== '')) ||
     (note26.overrides as { suppressReason?: string } | null)?.suppressReason === 'nil');
  if (!note26Valid) {
    issues.push({ checkId: 'disclosure.note26_events_declared', category: 'disclosure_quality', severity: 'warning', message: 'Note 26 must declare subsequent events or confirm nil events', sectionType: 'note_26' });
  }

  if (sfp?.data_snapshot) {
    const cr = sfp.data_snapshot.currentRatio;
    if (cr === undefined || cr === null) {
      log.warn('complianceCheckerService: currentRatio absent from data_snapshot — skipping going concern check');
    } else {
      const netLoss = Number(income?.data_snapshot?.netLoss ?? 0);
      if (Number(cr) < 1.0 || netLoss > 0) {
        if (!note27 || note27.status === 'pending') {
          issues.push({ checkId: 'disclosure.note27_going_concern', category: 'disclosure_quality', severity: 'warning', message: 'Going concern indicators present but Note 27 is not completed', sectionType: 'note_27', detail: `Current ratio: ${cr}, Net loss: ${netLoss}` });
        }
      }
    }
  }

  return issues;
}

// ── Exported function ─────────────────────────────────────────────────────────

export async function runComplianceCheck(
  companyId: string,
  documentId: string
): Promise<ComplianceResult> {
  log.info('complianceCheckerService: running compliance check', { companyId, documentId });

  const { doc, sections, templates } = await fetchDocumentSections(companyId, documentId);

  const allIssues = [
    ...runStructuralChecks(doc, sections, templates),
    ...runMathematicalChecks(sections),
    ...runDisclosureQualityChecks(sections),
  ];

  const totalChecks = 13; // 5 structural + 4 mathematical + 4 disclosure
  const score = computeScore(allIssues, totalChecks);
  const blockerCount = allIssues.filter(i => i.severity === 'blocker').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const passedCount = totalChecks - blockerCount - warningCount;

  log.info('complianceCheckerService: check complete', { companyId, documentId, score, blockerCount, warningCount });

  return {
    score,
    passedCount,
    warningCount,
    blockerCount,
    issues: allIssues,
    checkedAt: new Date().toISOString(),
  };
}
