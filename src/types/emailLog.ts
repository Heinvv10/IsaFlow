/**
 * Shared types for the Email Delivery Log feature.
 * Used by both the API route and the admin page.
 */

export interface EmailLogItem {
  id: string;
  company_id: string | null;
  company_name: string | null;
  recipient_email: string;
  subject: string;
  email_type: string;
  status: 'sent' | 'failed' | 'bounced';
  error_message: string | null;
  sent_at: string;
  sent_by: string | null;
}

export interface EmailLogStats {
  total_sent: number;
  total_failed: number;
  success_rate: number;
}

export interface EmailLogResponse {
  items: EmailLogItem[];
  total: number;
  page: number;
  limit: number;
  stats: EmailLogStats;
}
