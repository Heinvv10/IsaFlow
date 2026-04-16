import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsGenerationJob, GenerationJobStatus } from './afsTypes';

function rowToJob(row: Record<string, unknown>): AfsGenerationJob {
  return {
    id:           row.id as string,
    documentId:   row.document_id as string,
    companyId:    row.company_id as string,
    requestedBy:  (row.requested_by as string | null) ?? null,
    status:       row.status as GenerationJobStatus,
    startedAt:    row.started_at instanceof Date ? row.started_at
                    : row.started_at != null ? new Date(row.started_at as string) : null,
    completedAt:  row.completed_at instanceof Date ? row.completed_at
                    : row.completed_at != null ? new Date(row.completed_at as string) : null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt:    row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
  };
}

export async function enqueueGenerationJob(
  documentId: string,
  companyId: string,
  requestedBy: string | null
): Promise<AfsGenerationJob> {
  log.info('Enqueueing generation job', { documentId, companyId }, 'afsGenerationJobService');

  const rows = await sql`
    INSERT INTO afs_generation_log (document_id, company_id, requested_by, status)
    VALUES (${documentId}::UUID, ${companyId}::UUID, ${requestedBy ?? null}, 'queued')
    RETURNING *
  `;

  if (rows.length === 0) throw new Error('Failed to enqueue generation job');

  return rowToJob(rows[0] as Record<string, unknown>);
}

export async function getLatestJobForDocument(
  documentId: string,
  companyId: string
): Promise<AfsGenerationJob | null> {
  const rows = await sql`
    SELECT * FROM afs_generation_log
    WHERE document_id = ${documentId}::UUID
      AND company_id  = ${companyId}::UUID
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  return rowToJob(rows[0] as Record<string, unknown>);
}

export async function markJobStarted(jobId: string, companyId: string): Promise<void> {
  await sql`
    UPDATE afs_generation_log
    SET status = 'running', started_at = now()
    WHERE id = ${jobId}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function markJobCompleted(jobId: string, companyId: string): Promise<void> {
  await sql`
    UPDATE afs_generation_log
    SET status = 'completed', completed_at = now()
    WHERE id = ${jobId}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function markJobFailed(
  jobId: string,
  companyId: string,
  errorMessage: string
): Promise<void> {
  await sql`
    UPDATE afs_generation_log
    SET status = 'failed', completed_at = now(), error_message = ${errorMessage}
    WHERE id = ${jobId}::UUID AND company_id = ${companyId}::UUID
  `;
}
