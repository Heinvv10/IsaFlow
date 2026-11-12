/**
 * Admin console sign-in. middleware.ts rewrites /login on the admin host here,
 * so the URL stays /login; other hosts redirect this path to their own /login.
 */
import LoginPage from './login';

export default function ConsoleSignInPage() {
  return <LoginPage adminConsole />;
}
