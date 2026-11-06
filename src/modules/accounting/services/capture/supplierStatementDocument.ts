import { sql } from '@/lib/neon';

/**
 * Creates the captured_documents row that holds an uploaded supplier statement.
 * The table has no mime_type, source or created_by column: the type lives in
 * file_type and the uploader in uploaded_by.
 */
export async function insertStatementDocument(
  companyId: string,
  userId: string,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const fileType = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] ?? 'bin');
  const rows = (await sql`
    INSERT INTO captured_documents
      (company_id, file_name, file_type, document_type, status, uploaded_by)
    VALUES (${companyId}, ${fileName}, ${fileType}, 'statement', 'pending', ${userId}::uuid)
    RETURNING id
  `) as Array<{ id: string }>;
  const row = rows[0];
  if (!row) throw new Error('Failed to create captured_documents row');
  return row.id;
}
