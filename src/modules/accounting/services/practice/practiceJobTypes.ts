export interface PracticeJob {
  id: string;
  companyId: string;
  practiceClientId: string;
  jobCategoryId: string | null;
  title: string;
  description: string | null;
  partnerId: string | null;
  preparerId: string | null;
  dueDate: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'new' | 'in_progress' | 'review' | 'approved' | 'billed' | 'complete' | 'cancelled';
  financialYear: string | null;
  billingType: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours: number | null;
  fixedFeeAmount: number | null;
  /** Engagement Budget (rand, migration 850). NULL = no budget. */
  budgetAmount: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  practiceClientName?: string | null;
  jobCategoryName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeJobInput {
  practiceClientId: string;
  jobCategoryId?: string | null;
  title: string;
  description?: string | null;
  partnerId?: string | null;
  preparerId?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  financialYear?: string | null;
  billingType?: 'hourly' | 'fixed' | 'retainer' | null;
  budgetedHours?: number | null;
  fixedFeeAmount?: number | null;
  /** On update: absent = unchanged, null/'' = clear, a number = set. */
  budgetAmount?: number | null;
}

export interface JobFilters {
  practiceClientId?: string;
  partnerId?: string;
  preparerId?: string;
  status?: PracticeJob['status'];
  dueBefore?: string;
}
