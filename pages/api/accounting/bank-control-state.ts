import type {NextApiRequest,NextApiResponse} from 'next';
import {withAuth} from '@/lib/auth';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {readBankControlState} from '@/modules/accounting/services/bank/bankControlReadService';
async function handler(req:NextApiRequest,res:NextApiResponse){
 if(req.method!=='GET')return apiResponse.methodNotAllowed(res,req.method??'',['GET']);
 try{return apiResponse.success(res,await readBankControlState(requireControlTx(),req.query));}
 catch(error){if(error instanceof EffectivePermissionError)return apiResponse.forbidden(res,'Current bank read permission denied');
  return apiResponse.badRequestFromError(res,error,'Bank control state unavailable');}
}
export default withAuth(withErrorHandler(handler));
