// eslint-disable no-console -- This module is the logging fallback path; using
// console is intentional when structured logging is unavailable.
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import * as Sentry from '@sentry/nextjs';
import { apiLogger } from '@/lib/logger';
import { runWithRequestContext, generateRequestId } from '@/lib/observability/requestContext';
import { logRequestCompleted } from '@/lib/observability/requestLogger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { safeCorsOrigin } from '@/lib/cors';

const SENSITIVE_KEYS = new Set(['password', 'confirmPassword', 'password_hash', 'token', 'secret', 'apiKey', 'api_key']);

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : value;
  }
  return sanitized;
}

/**
 * Standard API error response
 */
export interface ApiErrorResponse {
  success: false;
  data: null;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Standard API success response
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Wraps an API handler with error handling.
 *
 * Generic R extends NextApiRequest to support AuthenticatedNextApiRequest,
 * CompanyAuthedRequest, or plain NextApiRequest without requiring `as any` casts.
 * The handler's res parameter is typed as NextApiResponse<any> so callers that
 * declare `res: NextApiResponse` (without a type argument) are assignable.
 */
 
export function withErrorHandler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (req: any, res: NextApiResponse<any>) => unknown
): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const requestId = generateRequestId();
    const startTime = Date.now();
    res.setHeader('X-Request-Id', requestId);

    // Defensive isolation: nest a fresh scope so setTenantTags never writes to
    // the global hub even if withAuth is absent or the wrap order is reversed.
    const runScoped = async () => {
      if (process.env.SENTRY_ENABLED === 'true') {
        setTenantTags({ requestId, route: sanitizeRoute(req.url) });
      }

      await runWithRequestContext(requestId, async () => {
      try {
        // CORS — single source of truth in src/lib/cors.ts (pentest M11).
        const origin = safeCorsOrigin(req.headers.origin);
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }

        // Handle OPTIONS request for CORS
        if (req.method === 'OPTIONS') {
          return res.status(200).end();
        }

        // Log incoming request
        apiLogger.info({
          type: 'request',
          method: req.method,
          url: req.url,
          query: req.query,
          body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
        }, `API Request: ${req.method} ${req.url}`);

        // Execute the actual handler
        await handler(req, res);

        // Log successful response
        const duration = Date.now() - startTime;
        apiLogger.info({
          type: 'response',
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          duration: `${duration}ms`,
        }, `API Response: ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);

      } catch (error) {
        const duration = Date.now() - startTime;

        // Log error with context
        apiLogger.error({
          type: 'error',
          method: req.method,
          url: req.url,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          duration: `${duration}ms`,
        });

        if (process.env.SENTRY_ENABLED === 'true' && error instanceof Error) {
          Sentry.captureException(error);
        }

        // Check if headers were already sent
        if (res.headersSent) {
          apiLogger.warn({ method: req.method, url: req.url }, 'Headers already sent, cannot send error response');
          return;
        }

        // Send error response — mask internal details in production
        const errorMessage =
          process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : error instanceof Error ? error.message : 'An unexpected error occurred';

        res.status(500).json({
          success: false,
          data: null,
          message: errorMessage,
          code: 'INTERNAL_SERVER_ERROR',
          ...(process.env.NODE_ENV === 'development' && {
            details: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
            } as Record<string, unknown> : { error: String(error) },
          }),
        });
      } finally {
        // Standard-shape request-completion log line. Reads userId/companyId
        // off req if withAuth populated them; otherwise null.
        const anyReq = req as unknown as {
          user?: { id?: string };
          companyId?: string;
        };
        logRequestCompleted({
          req,
          res,
          startMs: startTime,
          userId: anyReq.user?.id ?? null,
          companyId: anyReq.companyId ?? null,
        });
      }
    });
    }; // end runScoped

    if (process.env.SENTRY_ENABLED === 'true') {
      await Sentry.withIsolationScope(runScoped);
    } else {
      await runScoped();
    }
  };
}

/**
 * Creates a standard success response
 */
export function successResponse<T>(data: T, message?: string): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(message && { message }),
  };
}

/**
 * Creates a standard error response
 */
export function errorResponse(
  message: string,
  code?: string,
  details?: Record<string, unknown>
): ApiErrorResponse {
  return {
    success: false,
    data: null,
    message,
    ...(code && { code }),
    ...(details && process.env.NODE_ENV === 'development' && { details }),
  };
}

/**
 * Common HTTP error responses
 */
export const HttpErrors = {
  BadRequest: (message = 'Bad Request') =>
    errorResponse(message, 'BAD_REQUEST'),

  Unauthorized: (message = 'Unauthorized') =>
    errorResponse(message, 'UNAUTHORIZED'),

  Forbidden: (message = 'Forbidden') =>
    errorResponse(message, 'FORBIDDEN'),

  NotFound: (message = 'Not Found') =>
    errorResponse(message, 'NOT_FOUND'),

  MethodNotAllowed: (method: string) =>
    errorResponse(`Method ${method} not allowed`, 'METHOD_NOT_ALLOWED'),

  InternalServerError: (message = 'Internal Server Error') =>
    errorResponse(message, 'INTERNAL_SERVER_ERROR'),

  DatabaseError: (message = 'Database operation failed') =>
    errorResponse(message, 'DATABASE_ERROR'),

  ValidationError: (message = 'Validation failed', details?: Record<string, unknown>) =>
    errorResponse(message, 'VALIDATION_ERROR', details),
};
