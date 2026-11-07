/**
 * `Cache-Control: no-store` on every answer of a route that returns personal data
 * (payslips, wave 4 PS). Mount it directly inside withAuth, which sets its own
 * `private, no-store, must-revalidate`, and outside the role check, so a refusal
 * carries it too:
 *   export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
 */
import type { NextApiRequest, NextApiResponse } from 'next';

export function withNoStore(handler: (req: NextApiRequest, res: NextApiResponse) => unknown) {
  return (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    return handler(req, res);
  };
}
