export type PayrollControlRow=Record<string,unknown>;
export interface PayrollControlJournal {id:string;status:string;source:string;sourceRecordId:string|null;reversed:boolean;lines:{glAccountId:string;debit:string;credit:string}[]}
export interface PayrollControlRun {id:string;date:string;version:number|null;header:PayrollControlRow;lines:PayrollControlRow[];journal:PayrollControlJournal|null}
export interface PayrollControlPopulation {
 sourceTotals:Record<string,string>;currency:string|null;populationCount:number;lineCount:number;employeeCount:number;over:boolean;
 runs:PayrollControlRun[];employees:PayrollControlRow[];accounts:PayrollControlRow[];allocations:PayrollControlRow[];mappings:PayrollControlRow[];
 beneficiaryGroups:string[][];componentChanges:{employeeId:string;eventId:string;runId:string}[];
 declarations:{id:string;year:number;month:number;employee:string;employer:string;status:string;journal:PayrollControlJournal|null}[];
}
