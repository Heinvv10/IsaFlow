/**
 * Goods Received Notes (GRN) API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createGoodsReceived, GoodsReceivedError } from '@/modules/accounting/services/ap/goodsReceivedService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as CompanyAuthedRequest).companyId;

  if (req.method === 'GET') {
    const { purchaseOrderId } = req.query;
    let rows: Row[];
    if (purchaseOrderId) {
      rows = await sql`SELECT g.*, po.po_number FROM goods_received_notes g LEFT JOIN purchase_orders po ON g.purchase_order_id = po.id AND po.company_id = g.company_id WHERE g.purchase_order_id = ${String(purchaseOrderId)} AND g.company_id = ${companyId} ORDER BY g.received_date DESC` as Row[];
    } else {
      rows = await sql`SELECT g.*, po.po_number, s.name as supplier_name FROM goods_received_notes g LEFT JOIN purchase_orders po ON g.purchase_order_id = po.id AND po.company_id = g.company_id LEFT JOIN suppliers s ON po.supplier_id = s.id AND s.company_id = po.company_id WHERE g.company_id = ${companyId} ORDER BY g.received_date DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    try {
      const receipt = await createGoodsReceived(companyId, String(req.user.id), req.body);
      log.info('GRN created', { grn: receipt.grn_number, companyId }, 'accounting');
      return apiResponse.created(res, receipt);
    } catch (error) {
      if (error instanceof GoodsReceivedError) {
        return error.notFound ? apiResponse.notFound(res, 'Purchase order') : apiResponse.badRequest(res, error.message);
      }
      throw error;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
