export type AccountMatchStatus = 'match' | 'mismatch' | 'inconclusive' | 'parse_error';

export interface BulkPreviewResponse {
  filename: string;
  detectedBank: string | null;
  extractedAccountNumber: string | null;
  accountMatch: AccountMatchStatus;
  mismatchReason?: string;
  dateRange: { from: string; to: string } | null;
  totalParsed: number;
  duplicatesVsDb: number;
  rowHashes: string[];
  sampleTransactions: Array<{ date: string; amount: number; description: string }>;
  warnings: string[];
}

export interface BulkCommitResponse {
  filename: string;
  status: 'imported' | 'skipped' | 'failed';
  bulkImportId: string;
  bulkSequence: number;
  batchId?: string;
  transactionCount?: number;
  duplicateCount?: number;
  totalParsed?: number;
  appliedRules?: number;
  reason?: string;
}
