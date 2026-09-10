import type {NextApiRequest,NextApiResponse} from 'next';
import {withAuth} from '@/lib/auth';
import {withCsrf} from '@/lib/auth/withCsrf';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {parseExceptionList,parseExceptionCheck,parseExceptionAssignment,parseExceptionResolution} from '@/modules/accounting/services/controls/controlExceptionTypes';
import {listControlExceptions,captureControlExceptions,assignControlException,resolveControlException} from '@/modules/accounting/services/controls/controlExceptionService';
async function handler(req:NextApiRequest,res:NextApiResponse){
 try{
  if(req.method==='GET'){
   let input;try{input={...req.query,...(typeof req.query.limit==='string'?{limit:Number(req.query.limit)}:{})};parseExceptionList(input);}catch{return apiResponse.badRequest(res,'Invalid exception list');}
   return apiResponse.success(res,await listControlExceptions(requireControlTx(),input));
  }
  if(req.method!=='POST')return apiResponse.methodNotAllowed(res,req.method??'',['GET','POST']);
  let parsed:{action:'capture';input:ReturnType<typeof parseExceptionCheck>}|{action:'assign';input:ReturnType<typeof parseExceptionAssignment>}|{action:'resolve';input:ReturnType<typeof parseExceptionResolution>};
  try{
   const raw:unknown=JSON.parse(canonicalJson(req.body));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid body');
   const {action,...input}=raw as Record<string,unknown>;
   if(action==='capture')parsed={action,input:parseExceptionCheck(input)};
   else if(action==='assign')parsed={action,input:parseExceptionAssignment(input)};
   else if(action==='resolve')parsed={action,input:parseExceptionResolution(input)};
   else throw new Error('Invalid action');
  }catch{return apiResponse.badRequest(res,'Invalid exception action');}
  const ctx=requireControlTx(),result=parsed.action==='capture'?await captureControlExceptions(ctx,parsed.input)
   :parsed.action==='assign'?await assignControlException(ctx,parsed.input):await resolveControlException(ctx,parsed.input);
  return apiResponse.success(res,result);
 }catch(error){if(error instanceof EffectivePermissionError)return apiResponse.forbidden(res,'Current exception permission denied');throw error;}
}
export default withAuth(withErrorHandler(withCsrf(handler)));
