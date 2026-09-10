import type {NextApiRequest,NextApiResponse} from 'next';
import {z,ZodError} from 'zod';
import {withAuth} from '@/lib/auth';
import {withCsrf} from '@/lib/auth/withCsrf';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {parseAuditComparisonRequest} from '@/modules/accounting/services/controls/auditComparisonJobContract';
import {enqueueAuditComparison} from '@/modules/accounting/services/controls/auditComparisonJobService';
import {getAuditComparisonPage} from '@/modules/accounting/services/controls/auditComparisonPageService';
import {COMPARISON_SECTIONS} from '@/modules/accounting/services/controls/auditSnapshotComparisonMaterial';
const querySchema=z.object({comparisonId:z.string().uuid(),section:z.enum(COMPARISON_SECTIONS),
 limit:z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
 cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict();
/** Thin HTTP transport; shared services derive all source authority from retained authenticated headers. */
export async function auditComparisonsHandler(req:NextApiRequest,res:NextApiResponse){
 try{
  if(req.method==='POST'){
   const request=parseAuditComparisonRequest(req.body);
   return apiResponse.success(res,await enqueueAuditComparison(requireControlTx(),request));
  }
  if(req.method==='GET'){
   const request=querySchema.parse(req.query);
   return apiResponse.success(res,await getAuditComparisonPage(requireControlTx(),request));
  }
  return apiResponse.methodNotAllowed(res,req.method??'', ['GET','POST']);
 }catch(error){
  if(error instanceof ZodError)return apiResponse.badRequest(res,'Invalid audit comparison input');
  if(error instanceof EffectivePermissionError)return apiResponse.forbidden(res,'Current comparison source permission denied');
  throw error;
 }
}
export default withAuth(withErrorHandler(withCsrf(auditComparisonsHandler)));
