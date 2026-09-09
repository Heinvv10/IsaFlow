/**
 * Retired raw settlement mutation entry points.
 * Payment-addressed inverses use voidPaymentDocument and the approved AR/AP services;
 * cash applications use their immutable approved inverse and retain original rows.
 * These compatibility exports cannot authorize a mutation from bare entity IDs.
 */
export interface PaymentUnwindResult {invoicesReopened:number;amountUnapplied:number}
export interface BankAllocationUnwindResult extends PaymentUnwindResult {paymentsCancelled:number}
export async function unwindOnePayment(_companyId:string,_kind:'customer'|'supplier',_paymentId:string):Promise<PaymentUnwindResult>{
 throw new Error('Approved controlled cash or payment inverse required; raw settlement unwind is unavailable');
}
export async function unwindBankAllocationApplication(_companyId:string,_journalEntryId:string):Promise<BankAllocationUnwindResult>{
 throw new Error('Approved controlled bank or payment inverse required; raw settlement unwind is unavailable');
}
