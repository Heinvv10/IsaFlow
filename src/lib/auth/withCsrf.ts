import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { verifyCsrf } from './csrf';
import type { CompanyApiRequest } from './withCompany';

export type CompanyApiHandler = (req: CompanyApiRequest, res: NextApiResponse) => void | Promise<void>;

export function withCsrf(handler: CompanyApiHandler): CompanyApiHandler {
  return async (req: CompanyApiRequest, res: NextApiResponse) => {
    const method = req.method?.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return handler(req, res);
    }
    if (!verifyCsrf(req)) {
      return apiResponse.forbidden(res, 'CSRF token mismatch');
    }
    return handler(req, res);
  };
}
