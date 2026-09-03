// Director's Report generator.
//
// Only Pty Ltd and CC entity types render this report — Trusts and any
// future "sole_trader"/"partnership" entity types render an
// applicability placeholder so the regulator-facing document doesn't
// silently misstate the entity. The catalogue currently models pty/cc/
// trust; non-modelled types fall back to pty via getCompanyTerminology
// and would otherwise render incorrect leadership terms.

import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { getCompanyTerminology } from '../../entityTerminology';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

export async function generateDirectorsReport(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateDirectorsReport', { companyId, fiscalYear }, 'AfsPrimary');
  const { end: fyEnd } = await getFiscalRange(companyId, fiscalYear);
  const term = await getCompanyTerminology(companyId);

  // Trust + future sole_trader/partnership types should not render this
  // report — Pty/CC are the only entity types under SA Companies Act
  // that require a Directors' / Members' report.
  if (term.entityType !== 'pty' && term.entityType !== 'cc') {
    return {
      dataSnapshot: { fiscalYear, entityType: term.entityType, suppressReason: 'not_applicable' },
      content: {
        title: 'Report — Not Applicable',
        blocks: [
          { type: 'paragraph', text: `A ${term.leadershipCapital} report is not applicable for entity type "${term.entityType}". Remove this section from the AFS document or change the entity type to pty/cc.` },
        ],
      },
    };
  }

  return {
    dataSnapshot: { fiscalYear, entityType: term.entityType },
    content: {
      title: `${term.leadershipCapital} Report`,
      blocks: [
        { type: 'heading', level: 2, text: 'Nature of business' },
        { type: 'paragraph', text: `The ${term.entityRef} carries on the business as detailed in the principal activities. The ${term.leadership} confirm there have been no material changes during the period.` },
        { type: 'heading', level: 2, text: 'Review of activities' },
        { type: 'paragraph', text: `The financial results for the year ended ${fyEnd} are reflected in the annexed financial statements.` },
        { type: 'heading', level: 2, text: 'Going concern' },
        { type: 'paragraph', text: `The ${term.leadership} have reviewed the entity's projected cash flow and operating budgets and consider that the entity has adequate resources to continue as a going concern for the foreseeable future.` },
        { type: 'heading', level: 2, text: 'Events after the reporting date' },
        { type: 'paragraph', text: `The ${term.leadership} are not aware of any matter or circumstance arising since the end of the financial year that requires adjustment to or disclosure in the financial statements.` },
        { type: 'heading', level: 2, text: 'Auditor' },
        { type: 'paragraph', text: `The auditor will be appointed at the next annual general meeting in accordance with the ${term.actReference}.` },
      ],
    },
  };
}
