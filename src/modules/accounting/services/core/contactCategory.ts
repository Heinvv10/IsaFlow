/** A customer's category must be one of THIS company's (the column's FK does not know about tenants). */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { ContactValidationError } from './contactValidationError';

export async function assertCategoryInCompany(companyId: string, categoryId: string | null | undefined): Promise<void> {
  const id = typeof categoryId === 'string' ? categoryId.trim() : '';
  if (!id) return;
  if (!UUID_RE.test(id)) throw new ContactValidationError('category_id must be a customer category id');
  const rows = await sql`
    SELECT 1 FROM customer_categories WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  if (rows.length === 0) throw new ContactValidationError('category_id is not one of this company\'s customer categories');
}
