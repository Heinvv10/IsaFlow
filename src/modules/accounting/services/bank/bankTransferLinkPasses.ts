/** Exact controlled linking results shared by imports and the explicit relink route. */
export interface PendingTransferLink {bankTransactionId:string;intentId:string;approvalId:string}
export interface TransferLinkResult {linked:number;passes:number;failed:boolean;pending:PendingTransferLink[]}
