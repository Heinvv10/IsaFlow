/**
 * The admin portal's company-role rules (split out of adminUserActionsService.ts, #1656, to keep
 * that file under 300 lines). adminUserActionsService re-exports all three.
 */
import { NON_OWNER_COMPANY_ROLES } from '@/lib/auth/companyRoles';

/** The roles the admin portal may grant: the app's company roles but `owner` (#1656; migrations 883/1010 refuse owner too). */
export const ALLOWED_COMPANY_ROLES: readonly string[] = NON_OWNER_COMPANY_ROLES;

/** The refusal for removing or demoting a company's last owner (the admin site shows it). */
export const ONLY_OWNER_MESSAGE = "This user is the company's only owner. Make someone else owner first.";

/** Migration 908b's trigger refusal (RC011): no writer but app_user removes or demotes a last owner. */
export const isOnlyOwnerRefusal = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'RC011';
