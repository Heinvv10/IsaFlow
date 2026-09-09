import type {ControlTx} from './contracts';
import {assertGeneratedJournal,type ParentJournalControl} from './generatedJournalPermit';
/** Only an exact registered historical import child can use its approved closed accounting period. */
export function isAuthorizedHistoricalPosting(ctx:ControlTx,control:ParentJournalControl,header:Record<string,unknown>,period:Record<string,unknown>,accountingDate:string):boolean{
 if(control.parent.entityType!=='historical_import'||control.parent.operation!=='historical_import.post')return false;
 assertGeneratedJournal(ctx,control,String(header.id),'journal.post');
 return header.status==='draft'&&header.source==='auto_gl_import'&&header.source_record_id===control.parent.entityId
  &&header.entry_number===`HI-${control.parent.entityId}`&&period.status==='closed'
  &&String(period.start_date)<=accountingDate&&accountingDate<=String(period.end_date)&&control.permit.accountingDate===accountingDate;
}
