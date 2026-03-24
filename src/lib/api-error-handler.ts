import { NextApiRequest, NextApiResponse } from 'next';
import { apiLogger } from '@/lib/logger';

/**
 * Standard API error response
 */
export interface ApiErrorResponse {
  success: false;
  data: null;
  message: string;
  code?: string;
  details?: any;
}

/**
 * Standard API success response
 */
export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Wraps an API handler with error handling
 * Generic R extends NextApiRequest to support AuthenticatedNextApiRequest
 */
export function withErrorHandler<T = any, R extends NextApiRequest = NextApiRequest>(
  handler: (req: R, res: NextApiResponse<ApiResponse<T>>) => Promise<void>
) {
  return async (req: R, res: NextApiResponse<ApiResponse<T>>) => {
    const startTime = Date.now();

    try {
      // Set CORS headers - restrict to known origins
      const allowedOrigins = [
        'https://accounting.fibreflow.app',
        'http://localhost:3006',
        'http://localhost:3004',
      ];
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
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
        body: req.method !== 'GET' ? req.body : undefined,
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

      // Check if headers were already sent
      if (res.headersSent) {
        apiLogger.warn({ method: req.method, url: req.url }, 'Headers already sent, cannot send error response');
        return;
      }

      // Send error response
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

      res.status(500).json({
        success: false,
        data: null,
        message: errorMessage,
        code: 'INTERNAL_SERVER_ERROR',
        ...(process.env.NODE_ENV === 'development' && {
          details: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
          } : error,
        }),
      });
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
  details?: any
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

  ValidationError: (message = 'Validation failed', details?: any) =>
    errorResponse(message, 'VALIDATION_ERROR', details),
};
