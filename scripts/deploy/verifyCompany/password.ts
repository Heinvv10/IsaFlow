/** Which password a provisioning run gives the verify login: the env file's, or a new random one. */
import { randomBytes } from 'node:crypto';
import { VERIFY_USER_EMAIL } from './config';

/**
 * @param goTrueUserExists the login is already in GoTrue
 * @param fileLogin what the deploy env file holds (readVerifyLogin), or null
 * @throws when the login exists, the file cannot say its password and nothing asks for a reset: a new password would
 *   change something that exists
 */
export function choosePassword(
  goTrueUserExists: boolean, fileLogin: { email: string; password: string } | null, resetPassword: boolean,
): { password: string; generated: boolean } {
  if (fileLogin && fileLogin.email.toLowerCase() === VERIFY_USER_EMAIL && !resetPassword) return { password: fileLogin.password, generated: false };
  if (goTrueUserExists && !resetPassword) {
    throw new Error(`the GoTrue login ${VERIFY_USER_EMAIL} exists but the env file holds no password for it; pass --reset-password to set a new one`);
  }
  return { password: randomBytes(24).toString('base64url'), generated: true };
}
