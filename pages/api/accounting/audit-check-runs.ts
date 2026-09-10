import type {NextApiRequest,NextApiResponse} from 'next';
import {z,ZodError} from 'zod';
import {withAuth} from '@/lib/auth';
import {withCsrf} from '@/lib/auth/withCsrf';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {ErrorCode} from '@/lib/apiResponse.types';
import {AuditEnqueueQuotaError} from '@/modules/accounting/services/controls/auditEnqueueQuota';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {CheckRunUnavailableError,getAuditCheckRunPage} from '@/modules/accounting/services/controls/auditCheckRunReadService';
const querySchema=z.object({checkRunId:z.string().uuid(),
 limit:z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
 cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
/** Thin HTTP transport; the shared services derive every authority from the retained authenticated intent. */
export async function auditCheckRunsHandler(req:NextApiRequest,res:NextApiResponse){
 try{
  if(req.method==='POST'){
   // The contract parses the body: no requester, permission, group or limit override is accepted from the wire.
   return apiResponse.success(res,await enqueueAuditCheckRuns(requireControlTx(),req.body));
  }
  if(req.method==='GET'){
   const request=querySchema.parse(req.query);
   return apiResponse.success(res,await getAuditCheckRunPage(requireControlTx(),request));
  }
  return apiResponse.methodNotAllowed(res,req.method??'',['GET','POST']);
 }catch(error){
  if(error instanceof ZodError)return apiResponse.badRequest(res,'Invalid audit check run input');
  if(error instanceof EffectivePermissionError)return apiResponse.forbidden(res,'Current report permission denied');
  // 409 means "ask again later"; a failed run never will publish, so it answers a terminal 422 of its own.
  if(error instanceof CheckRunUnavailableError)return error.reason==='not_ready'?apiResponse.conflict(res,error.message)
   :error.reason==='failed'?apiResponse.error(res,ErrorCode.BUSINESS_RULE_VIOLATION,error.message):apiResponse.notFound(res,'Check run');
  if(error instanceof AuditEnqueueQuotaError)return apiResponse.tooManyRequests(res,error.message);
  throw error;
 }
}
export default withAuth(withErrorHandler(withCsrf(auditCheckRunsHandler)));
