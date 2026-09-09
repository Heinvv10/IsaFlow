export type HistoricalImportKind='gl'|'opening_balance'|'customer_invoice'|'supplier_invoice';
export type HistoricalImportMode='post_journal'|'attach_subledger';
export type HistoricalImportSystem='sage'|'xero'|'quickbooks'|'pastel'|'csv';
export interface HistoricalImportRecord {recordId:string;accountCode:string;debit:string;credit:string;description:string;vatType?:string}
export interface HistoricalImportDocument {
 partyId:string;invoiceNumber:string;dueDate:string;subtotal:string;taxAmount:string;totalAmount:string;amountPaid:string;
 settlements:Array<{journalId:string;amount:string}>;
}
export interface HistoricalImportSource {
 version:1;sourceSystem:HistoricalImportSystem;sourceKey:string;kind:HistoricalImportKind;mode:HistoricalImportMode;
 accountingDate:string;currency:'ZAR';records:HistoricalImportRecord[];document?:HistoricalImportDocument;existingJournalId?:string;
}
export interface HistoricalImportNormalized extends HistoricalImportSource {amount:string}
export interface HistoricalImportPrepareInput {
 sourceSystem:HistoricalImportSystem;sourceKey:string;kind:HistoricalImportKind;mode:HistoricalImportMode;
 accountingDate:string;evidenceId:string;sourceRecordIds:string[];
}
export interface HistoricalImportPrepared {importId:string;operation:'historical_import.post';amount:string;currency:'ZAR';accountingDate:string;fingerprint:string;requiresApproval:true}
