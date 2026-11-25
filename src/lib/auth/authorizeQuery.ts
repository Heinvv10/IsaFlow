/**
 * The /oauth/authorize query string, read as strings (a repeated or absent parameter reads as '', except
 * code_challenge_method, which defaults to S256). Kept out of pages/oauth/authorize.tsx for its 300-line cap.
 */
export interface AuthorizeQuery {
  clientId: string;
  redirectUri: string;
  scopeStr: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function readAuthorizeQuery(q: Record<string, unknown>): AuthorizeQuery {
  return {
    clientId: str(q.client_id),
    redirectUri: str(q.redirect_uri),
    scopeStr: str(q.scope),
    state: str(q.state),
    codeChallenge: str(q.code_challenge),
    codeChallengeMethod: typeof q.code_challenge_method === 'string' ? q.code_challenge_method : 'S256',
    responseType: str(q.response_type),
  };
}
