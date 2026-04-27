/**
 * GET /api/admin/billing/flow-bundles — list all bundles (active + inactive)
 * POST /api/admin/billing/flow-bundles — create a new bundle
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

const PostBody = z.object({
  name:         z.string().min(1).max(100),
  flows:        z.number().int().positive(),
  priceCents:   z.number().int().nonnegative(),
  isActive:     z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
}).strict();

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, name, flows, price_cents, is_active, display_order, created_at, updated_at
        FROM flow_bundles
       ORDER BY display_order, created_at
    `) as Array<Record<string, unknown>>;
    const bundles = rows.map((r) => ({
      id:           r.id as string,
      name:         r.name as string,
      flows:        r.flows as number,
      priceCents:   r.price_cents as number,
      isActive:     r.is_active as boolean,
      displayOrder: r.display_order as number,
      createdAt:    r.created_at as Date,
      updatedAt:    r.updated_at as Date,
    }));
    return apiResponse.success(res, { bundles });
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }
    const rows = (await sql`
      INSERT INTO flow_bundles (name, flows, price_cents, is_active, display_order)
      VALUES (${parsed.data.name}, ${parsed.data.flows}, ${parsed.data.priceCents},
              ${parsed.data.isActive ?? true}, ${parsed.data.displayOrder ?? 0})
      RETURNING id
    `) as Array<{ id: string }>;

    await logAdminAction(
      req.user.id,
      'flow.bundle.create',
      'flow_bundle',
      rows[0]!.id,
      parsed.data,
      getIp(req),
    );

    return apiResponse.created(res, { id: rows[0]!.id });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
