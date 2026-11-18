/**
 * Barrel and routes for the intercompany (999z) suites: the fixture, sessions, planted rows and refusals, and the real
 * routes called with real signed tokens.
 */
import connectionsRoute from '../../../pages/api/accounting/intercompany/connections';
import connectionRoute from '../../../pages/api/accounting/intercompany/connections/[id]';
import settingsRoute from '../../../pages/api/accounting/intercompany/connections/[id]/settings';
import candidatesRoute from '../../../pages/api/accounting/intercompany/group-candidates';
import optionsRoute from '../../../pages/api/accounting/intercompany/side-options';
import { callRoute } from '../r035-approval.helpers';
import { tokens } from './intercompany.fixture';

export * from './intercompany.fixture';
export * from './intercompany.session';
export * from './intercompany.plant';
export { R } from './intercompany.refusals';

const url = '/api/accounting/intercompany/connections';
export const api = {
  list: (user: string, company: string) => callRoute(connectionsRoute, tokens[user]!, company, 'GET', undefined, url),
  create: (user: string, company: string, body: unknown) => callRoute(connectionsRoute, tokens[user]!, company, 'POST', body, url),
  edit: (user: string, company: string, id: string, body: unknown) =>
    callRoute(connectionRoute, tokens[user]!, company, 'PUT', body, `${url}/${id}`, { id }),
  settings: (user: string, company: string, id: string, body: unknown) =>
    callRoute(settingsRoute, tokens[user]!, company, 'PUT', body, `${url}/${id}/settings`, { id }),
  revoke: (user: string, company: string, id: string) =>
    callRoute(connectionRoute, tokens[user]!, company, 'DELETE', undefined, `${url}/${id}`, { id }),
  candidates: (user: string, company: string) =>
    callRoute(candidatesRoute, tokens[user]!, company, 'GET', undefined, '/api/accounting/intercompany/group-candidates'),
  options: (user: string, company: string) =>
    callRoute(optionsRoute, tokens[user]!, company, 'GET', undefined, '/api/accounting/intercompany/side-options'),
};

