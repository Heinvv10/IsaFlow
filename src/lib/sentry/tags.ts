import * as Sentry from '@sentry/nextjs';

export interface TenantTagContext {
  companyId?: string;
  userId?: string;
  requestId?: string;
  route?: string;
}

export function setTenantTags(ctx: TenantTagContext): void {
  if (process.env.SENTRY_ENABLED !== 'true') return;
  if (ctx.companyId) Sentry.setTag('company_id', ctx.companyId);
  if (ctx.requestId) Sentry.setTag('request_id', ctx.requestId);
  if (ctx.route) Sentry.setTag('route', ctx.route);
  if (ctx.userId) Sentry.setUser({ id: ctx.userId });
}
