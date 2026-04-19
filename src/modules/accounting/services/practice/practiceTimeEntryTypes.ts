export interface PracticeTimeEntry {
  id: string;
  companyId: string;
  userId: string;
  entryDate: string;
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes: string | null;
  billable: boolean;
  appliedRate: number | null;
  lineTotal: number | null;
  origin: 'manual' | 'assisted' | 'recurring';
  status: 'draft' | 'submitted' | 'approved' | 'billed' | 'not_billable' | 'leave' | 'invoiced';
  approvedBy: string | null;
  approvedAt: string | null;
  billedAt: string | null;
  invoiceId: string | null;
  jobId: string | null;
  writeOffReason: string | null;
  writtenOffBy: string | null;
  writtenOffAt: string | null;
  practiceClientName?: string | null;
  jobCategoryName?: string | null;
  workItemName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeTimeEntryInput {
  entryDate: string;
  hours: number;
  practiceClientId: string;
  jobCategoryId: string;
  workItemId: string;
  taskDescription: string;
  notes?: string | null;
  billable?: boolean;
  origin?: 'manual' | 'assisted' | 'recurring';
  jobId?: string | null;
}

export interface PracticeTimeEntryUpdateInput {
  entryDate?: string;
  hours?: number;
  practiceClientId?: string;
  jobCategoryId?: string;
  workItemId?: string;
  taskDescription?: string;
  notes?: string | null;
  billable?: boolean;
  jobId?: string | null;
}

export interface PracticeEntryFilters {
  userId?: string;
  practiceClientId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: PracticeTimeEntry['status'];
  jobId?: string;
}
