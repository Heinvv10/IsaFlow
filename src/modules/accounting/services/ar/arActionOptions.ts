import {z} from 'zod';
import {isRealCalendarDate} from '@/lib/validation';
const options=z.object({
 approvalId:z.string().uuid().optional(),
 reversalDate:z.string().refine(isRealCalendarDate,'Invalid reversal date').optional(),
 applicationId:z.string().uuid().optional(),
 runId:z.string().uuid().optional(),
});
/** Requests select persisted intent/approval identifiers; authority remains in shared services. */
export function parseArActionOptions(body:unknown){return options.parse(body);}
