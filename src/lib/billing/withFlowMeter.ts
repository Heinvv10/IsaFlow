/**
 * PAYG Flow metering middleware.
 *
 * Composes INSIDE `withAuth` — relies on `req.companyId` being populated.
 *
 * Contract:
 *   - Non-PAYG tenants:          handler runs unchanged.
 *   - PAYG with sufficient flows: debit first → run handler → if handler
 *                                 throws, returns a 4xx/5xx, or called
 *                                 `markFlowNoOp`, refund.
 *   - PAYG with insufficient flows:
 *       • If auto-topup is enabled and succeeds, retry the debit.
 *       • Otherwise return 402 `{ reason: 'insufficient_flows', balance, required }`.
 *
 * After a successful response, `recalculateNudge` is fire-and-forget so the
 * next page load sees the new banner level.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import {
  deductFlows,
  refundFlows,
  triggerAutoTopup,
  recalculateNudge,
  InsufficientFlowsError,
} from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from './getCompanyPlan';
import type { FlowOperationCode } from '@/modules/billing/services/flowOperationCatalog';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

interface CompanyReq extends NextApiRequest {
  companyId: string;
  flowNoOp?: boolean;
}

/**
 * Declares that this request did no billable work, so the debit is refunded
 * even though the handler answers 2xx.
 *
 * For the idempotent-success shape: a retry that finds the work already done
 * and writes nothing answers 200, not 4xx, because the caller's goal IS met —
 * but charging it turns a timeout-retry loop into a bill for one operation
 * repeated. Only the handler can know, so only the handler may say so.
 */
export function markFlowNoOp(req: NextApiRequest): void {
  (req as CompanyReq).flowNoOp = true;
}

export function withFlowMeter(operationCode: FlowOperationCode, flowCost: number) {
  if (flowCost <= 0 || !Number.isInteger(flowCost)) {
    throw new Error(`withFlowMeter: flowCost must be positive integer, got ${flowCost}`);
  }
  return (handler: Handler): Handler => {
    return async (req: CompanyReq, res: NextApiResponse) => {
      const companyId = req.companyId;
      if (!companyId) {
        // Defensive — withFlowMeter must compose inside withAuth.
        log.error('withFlowMeter: req.companyId missing — middleware misordered', {}, 'BILLING');
        return apiResponse.internalError(res, new Error('metering_unavailable'));
      }

      const plan = await getCompanyPlan(companyId);
      if (!plan || plan.planCode !== 'payg') {
        // Non-PAYG tenants pay via subscription; nothing to meter.
        return handler(req, res);
      }

      let balanceAfter: number;
      try {
        const r = await deductFlows(companyId, flowCost, operationCode, null);
        balanceAfter = r.balanceAfter;
      } catch (err) {
        if (err instanceof InsufficientFlowsError) {
          // Try auto top-up once; only succeeds in v2 when a payment method is stored.
          const topup = await triggerAutoTopup(companyId);
          if (topup.success) {
            const r = await deductFlows(companyId, flowCost, operationCode, null);
            balanceAfter = r.balanceAfter;
          } else {
            return apiResponse.paymentRequired(res, {
              balance: err.balance,
              required: err.required,
              operationCode,
            });
          }
        } else {
          throw err;
        }
      }

      // Surface pre/post balance so clients can render "X Flows used" toasts.
      res.setHeader('X-Flow-Balance-After', String(balanceAfter));
      res.setHeader('X-Flow-Operation', operationCode);
      res.setHeader('X-Flow-Cost', String(flowCost));

      // Track whether the handler completed successfully.  If it threw or if
      // Next.js sees a non-2xx status code, we refund the debit.
      let handlerError: unknown = null;
      try {
        await handler(req, res);
      } catch (err) {
        handlerError = err;
      }

      const statusCode = res.statusCode;
      const responded4xxOr5xx = statusCode >= 400 && statusCode < 600;

      if (handlerError || responded4xxOr5xx || req.flowNoOp) {
        try {
          const refund = await refundFlows(companyId, flowCost, operationCode, null);
          // Re-stated from the REFUND, not left at the debit. `markFlowNoOp`
          // makes this branch reachable on a 2xx, which is where the "X Flows
          // used" toast this header exists for is actually rendered — a client
          // reading the stale value shows a charge that was reversed.
          res.setHeader('X-Flow-Balance-After', String(refund.balanceAfter));
          res.setHeader('X-Flow-Refunded', 'true');
        } catch (refundErr) {
          log.error(
            'flow refund failed after handler error',
            refundErr instanceof Error
              ? { message: refundErr.message, companyId, operationCode }
              : { refundErr, companyId, operationCode },
            'BILLING',
          );
        }
        if (handlerError) throw handlerError;
      } else {
        // Fire-and-forget nudge recalc — never blocks the response.
        void recalculateNudge(companyId).catch((err: unknown) => {
          log.warn(
            'recalculateNudge failed',
            err instanceof Error ? { message: err.message, companyId } : { err, companyId },
            'BILLING',
          );
        });
      }
    };
  };
}
