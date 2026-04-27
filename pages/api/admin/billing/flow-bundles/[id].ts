/**
 * GET    /api/admin/billing/flow-bundles/[id]
 * PATCH  /api/admin/billing/flow-bundles/[id] — update editable fields
 * DELETE /api/admin/billing/flow-bundles/[id] — soft delete (is_active = false)
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';

const PatchBody = z.object({
  name:         z.string().min(1).max(100).optional(),
  flows:        z.number().int().positive().optional(),
  priceCents:   z.number().int().nonnegative().optional(),
  isActive:     z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
}).strict();

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return apiResponse.badRequest(res, 'id is required');
  }

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, name, flows, price_cents, is_active, display_order, created_at, updated_at
        FROM flow_bundles WHERE id = ${id} LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) return apiResponse.notFound(res, 'Bundle', id);
    const r = rows[0]!;
    return apiResponse.success(res, {
      id: r.id, name: r.name, flows: r.flows,
      priceCents: r.price_cents, isActive: r.is_active,
      displayOrder: r.display_order, createdAt: r.created_at, updatedAt: r.updated_at,
    });
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    const updates: string[] = [];
    const values: unknown[] = [];
    if (parsed.data.name !== undefined)         { values.push(parsed.data.name);         updates.push(`name = $${values.length}`); }
    if (parsed.data.flows !== undefined)        { values.push(parsed.data.flows);        updates.push(`flows = $${values.length}`); }
    if (parsed.data.priceCents !== undefined)   { values.push(parsed.data.priceCents);   updates.push(`price_cents = $${values.length}`); }
    if (parsed.data.isActive !== undefined)     { values.push(parsed.data.isActive);     updates.push(`is_active = $${values.length}`); }
    if (parsed.data.displayOrder !== undefined) { values.push(parsed.data.displayOrder); updates.push(`display_order = $${values.length}`); }

    if (updates.length === 0) {
      return apiResponse.badRequest(res, 'No fields to update');
    }

    values.push(id);
    const rows = (await sql.unsafe(
      `UPDATE flow_bundles SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values,
    )) as Array<{ id: string }>;

    if (rows.length === 0) return apiResponse.notFound(res, 'Bundle', id);

    await logAdminAction(req.user.id, 'flow.bundle.update', 'flow_bundle', id, parsed.data, getIp(req));
    return apiResponse.success(res, { id });
  }

  if (req.method === 'DELETE') {
    // Soft delete only — flow_purchases FKs into flow_bundles.
    const rows = (await sql`
      UPDATE flow_bundles SET is_active = false WHERE id = ${id} RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) return apiResponse.notFound(res, 'Bundle', id);

    await logAdminAction(req.user.id, 'flow.bundle.deactivate', 'flow_bundle', id, {}, getIp(req));
    return apiResponse.success(res, { id, isActive: false });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
