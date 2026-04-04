/**
 * Auth Types
 * Core type definitions for the authentication system
 */

export interface AuthUser {
  id: string;
  /** @deprecated Use `id` instead */
  userId: string; // Alias for id for backwards compatibility
  email: string;
  firstName: string;
  lastName: string;
  /** Full name (firstName + lastName) */
  name: string;
  role: AuthRole;
  permissions: string[];
  isActive: boolean;
  profilePicture?: string;
  department?: string;
  mustChangePassword?: boolean;
}

export type AuthRole = 'super_admin' | 'admin' | 'manager' | 'storeman' | 'technician' | 'viewer' | 'system';

export interface JWTPayload {
  sub: string; // user id
  email: string;
  role: AuthRole;
  /** @deprecated Permissions no longer stored in JWT — fetched from DB via middleware */
  permissions: string[];
  sessionId: string;
  iat: number;
  exp: number;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

export interface AuthenticatedRequest {
  user: AuthUser;
  sessionId: string;
}

// Role hierarchy for permission checks
export const ROLE_HIERARCHY: Record<AuthRole, number> = {
  super_admin: 6,
  system: 5,
  admin: 4,
  manager: 3,
  storeman: 2,
  technician: 2,
  viewer: 1,
};

// Common permissions
export const PERMISSIONS = {
  // Projects
  PROJECTS_VIEW: 'projects.view',
  PROJECTS_MANAGE: 'projects.manage',
  PROJECTS_DELETE: 'projects.delete',

  // Staff
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',
  STAFF_DELETE: 'staff.delete',

  // Procurement
  PROCUREMENT_VIEW: 'procurement.view',
  PROCUREMENT_MANAGE: 'procurement.manage',
  PROCUREMENT_APPROVE: 'procurement.approve',

  // Fleet
  FLEET_VIEW: 'fleet.view',
  FLEET_MANAGE: 'fleet.manage',

  // Admin
  USERS_MANAGE: 'users.manage',
  SETTINGS_MANAGE: 'settings.manage',

  // Wildcard
  ALL: 'all',
} as const;
