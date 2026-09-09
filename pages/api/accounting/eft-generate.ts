/** Explicit immutable EFT preparation, authorized release, and protected artifact download. */
import type {NextApiResponse} from 'next';
import {withErrorHandler} from '@/lib/api-error-handler';
import {apiResponse} from '@/lib/apiResponse';
import {withAuth,type CompanyAuthedRequest} from '@/lib/auth';
import {withCsrf} from '@/lib/auth/withCsrf';
import {performPaymentReleaseAction} from '@/modules/accounting/services/ap/paymentReleaseActionService';
async function handler(req:CompanyAuthedRequest,res:NextApiResponse){
 if(req.method!=='POST')return apiResponse.methodNotAllowed(res,req.method!,['POST']);
 return apiResponse.success(res,await performPaymentReleaseAction('eft',req.body));
}
export default withAuth(withErrorHandler(withCsrf(handler as Parameters<typeof withAuth>[0])));
