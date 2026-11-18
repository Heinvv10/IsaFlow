/** Which password a provisioning run gives a login: the env file's (final or pending), or a new random one. */
import { randomBytes } from 'node:crypto';
import type { LoginIdentity } from './identity';
import type { Login } from './envFile';

export interface PasswordChoice {
  password: string;
  /** A new password: GoTrue has to be given it (a new login, or --reset-password). */
  generated: boolean;
  /** The password came from the pending key: a run saved it and died before it finished (GoTrue may not hold it yet). */
  resumed: boolean;
}

/**
 * @param goTrueUserExists the login is already in GoTrue
 * @param fileLogin what the deploy env file holds for it, or null
 * @param pending the password a run saved right after creating the login, or null
 * @throws when the login exists, the file holds no password for it and nothing asks for a reset: a new password would
 *   change something that exists
 */
export function choosePassword(
  who: LoginIdentity, goTrueUserExists: boolean, fileLogin: Login | null, pending: string | null, resetPassword: boolean,
): PasswordChoice {
  if (!resetPassword) {
    // A pending password is newer than the file's final one: it is removed when a run finishes, so one that is still there
    // belongs to a run that died, which may or may not have got as far as telling GoTrue.
    if (pending) return { password: pending, generated: false, resumed: true };
    if (fileLogin && fileLogin.email.toLowerCase() === who.email) return { password: fileLogin.password, generated: false, resumed: false };
    if (goTrueUserExists) {
      throw new Error(`the GoTrue login ${who.email} exists but the env file holds no password for it; pass --reset-password to set a new one`);
    }
  }
  return { password: randomBytes(24).toString('base64url'), generated: true, resumed: false };
}
