import type {NextApiRequest,NextApiResponse} from 'next';
import {z} from 'zod';
import {withAuth} from '@/lib/auth';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {withCsrf} from '@/lib/auth/withCsrf';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {getApprovalRequirements,requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {listOperationApprovals} from '@/modules/accounting/services/controls/approvalReadService';
const refSchema=z.object({entityType:z.string().min(1).max(100),entityId:z.string().min(1).max(128),operation:z.enum(CONTROL_OPERATIONS),
 expectedVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),reversalDate:z.string().max(10).optional()}).strict();
const evidenceSchema=z.object({entityType:z.string().min(1).max(100),entityId:z.string().min(1).max(128),store:z.enum(['captured','procurement','bank_attachment','protected']),
 evidenceId:z.string().uuid(),version:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),hash:z.string().max(128).nullable()}).strict();
const bodySchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('requirements'),ref:refSchema}).strict(),z.object({action:z.literal('request'),ref:refSchema}).strict(),
 z.object({action:z.literal('decide'),approvalId:z.string().uuid(),decision:z.enum(['approved','rejected','cancelled']),evidence:z.array(evidenceSchema).max(20).optional()}).strict(),
]);
const querySchema=z.object({action:z.enum(['list','pending']).optional(),status:z.enum(['pending','approved','rejected','cancelled','consumed']).optional(),
 limit:z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),cursor:z.string().min(1).max(2048).optional()}).strict();
/** Exported for real-control transaction integration tests; the HTTP export always authenticates and checks CSRF. */
async function dispatchApprovalAction(req:NextApiRequest,res:NextApiResponse){
 if(req.method==='GET'){
  const parsed=querySchema.safeParse(req.query);
  if(!parsed.success||(parsed.data.action==='pending'&&parsed.data.status&&parsed.data.status!=='pending'))return apiResponse.badRequest(res,'Invalid approval list query');
  const {action,...options}=parsed.data;
  return apiResponse.success(res,await listOperationApprovals(requireControlTx(),{...options,...(action==='pending'?{status:'pending' as const}:{})}));
 }
 if(req.method==='POST'){
  const parsed=bodySchema.safeParse(req.body);if(!parsed.success)return apiResponse.badRequest(res,'Invalid approval action');
  const input=parsed.data;
  if(input.action==='decide')return apiResponse.success(res,await decideOperationApproval(requireControlTx(),input.approvalId,input.decision,input.evidence));
  let ref;
  try{ref=canonicalOperationRef(input.ref);}catch{return apiResponse.badRequest(res,'Invalid controlled operation reference');}
  const result=input.action==='requirements'?await getApprovalRequirements(requireControlTx(),ref):await requestOperationApproval(requireControlTx(),ref);
  return apiResponse.success(res,result);
 }
 return apiResponse.methodNotAllowed(res,req.method??'', ['GET','POST']);
}
export async function controlApprovalsHandler(req:NextApiRequest,res:NextApiResponse){
 try{return await dispatchApprovalAction(req,res);}catch(error){
  if(error instanceof EffectivePermissionError)return apiResponse.forbidden(res,'Current approval permission denied');
  throw error;
 }
}
export default withAuth(withErrorHandler(withCsrf(controlApprovalsHandler)));
