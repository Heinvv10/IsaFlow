import { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { safeCorsOrigin } from '@/lib/cors';
import {
  ErrorCode,
  STATUS_CODE_MAP,
} from './apiResponse.types';

// Re-export all types and enums so existing imports continue to work
export type {
  ApiSuccessResponse,
  ApiErrorResponse,
  ApiPaginatedResponse,
  ApiResponse,
} from './apiResponse.types';
export { ErrorCode, STATUS_CODE_MAP } from './apiResponse.types';

/**
 * API Response Helper Class
 */
export class ApiResponseHelper {
  private static generateMeta(additionalMeta?: Record<string, unknown>) {
    return {
      timestamp: new Date().toISOString(),
      ...additionalMeta,
    };
  }

  /**
   * Send success response
   */
  static success<T>(
    res: NextApiResponse,
    data: T,
    message?: string,
    statusCode = 200,
    meta?: Record<string, unknown>
  ): void {
    const response = {
      success: true as const,
      data,
      ...(message && { message }),
      meta: this.generateMeta(meta),
    };

    res.status(statusCode).json(response);
  }

  /**
   * Send created response (201)
   */
  static created<T>(
    res: NextApiResponse,
    data: T,
    message = 'Resource created successfully',
    meta?: Record<string, unknown>
  ): void {
    this.success(res, data, message, 201, meta);
  }

  /**
   * Send no content response (204)
   */
  static noContent(res: NextApiResponse): void {
    res.status(204).end();
  }

  /**
   * Send paginated response
   */
  static paginated<T>(
    res: NextApiResponse,
    data: T[],
    pagination: {
      page: number;
      pageSize: number;
      total: number;
    },
    message?: string,
    meta?: Record<string, unknown>
  ): void {
    const totalPages = Math.ceil(pagination.total / pagination.pageSize);

    const response = {
      success: true as const,
      data,
      pagination: {
        ...pagination,
        totalPages,
      },
      ...(message && { message }),
      meta: this.generateMeta(meta),
    };

    res.status(200).json(response);
  }

  /**
   * Send error response
   */
  static error(
    res: NextApiResponse,
    code: ErrorCode,
    message: string,
    details?: unknown,
    meta?: Record<string, unknown>
  ): void {
    const statusCode = STATUS_CODE_MAP[code] || 500;

    const response = {
      success: false as const,
      error: {
        code,
        message,
        ...(details !== undefined && { details: details as Record<string, unknown> }),
      },
      meta: this.generateMeta(meta),
    };

    res.status(statusCode).json(response);
  }

  /**
   * Send bad request error response (400)
   */
  static badRequest(
    res: NextApiResponse,
    message: string,
    details?: unknown
  ): void {
    this.error(res, ErrorCode.BAD_REQUEST, message, details);
  }

  /**
   * Send a bad-request error derived from a caught exception.
   * Logs the original error message + stack internally, but only surfaces
   * `publicMessage` to the client. Prevents ORM constraint names / internal
   * detail from leaking via raw `err.message` in production (pentest H16).
   *
   * In development, the response body includes the original error for
   * debugging; in production, only `publicMessage` is returned.
   */
  static badRequestFromError(
    res: NextApiResponse,
    error: Error | unknown,
    publicMessage: string
  ): void {
    log.warn(
      'Bad request',
      error instanceof Error ? { message: error.message, stack: error.stack } : { error },
      'ApiResponse',
    );
    const isDevelopment = process.env.NODE_ENV === 'development';
    const details = isDevelopment && error instanceof Error
      ? { originalMessage: error.message }
      : undefined;
    this.error(res, ErrorCode.BAD_REQUEST, publicMessage, details);
  }

  /**
   * Send validation error response
   */
  static validationError(
    res: NextApiResponse,
    errors: Record<string, string | string[]>,
    message = 'Validation failed'
  ): void {
    this.error(res, ErrorCode.VALIDATION_ERROR, message, errors);
  }

  /**
   * Send not found error response
   */
  static notFound(
    res: NextApiResponse,
    resource: string,
    identifier?: string | number
  ): void {
    const message = identifier
      ? `${resource} with identifier '${identifier}' not found`
      : `${resource} not found`;

    this.error(res, ErrorCode.NOT_FOUND, message);
  }

  /**
   * Send unauthorized error response
   */
  static unauthorized(
    res: NextApiResponse,
    message = 'Authentication required'
  ): void {
    this.error(res, ErrorCode.UNAUTHORIZED, message);
  }

  /**
   * Send forbidden error response
   */
  static forbidden(
    res: NextApiResponse,
    message = 'You do not have permission to perform this action'
  ): void {
    this.error(res, ErrorCode.FORBIDDEN, message);
  }

  /**
   * Send payment-required error response (402).
   * Used by the PAYG Flow metering middleware when a tenant's wallet balance
   * is below the cost of the requested operation.
   */
  static paymentRequired(
    res: NextApiResponse,
    details: { balance: number; required: number; operationCode?: string },
    message = 'Insufficient Flows — top up your wallet to continue'
  ): void {
    this.error(res, ErrorCode.PAYMENT_REQUIRED, message, { reason: 'insufficient_flows', ...details });
  }

  /**
   * Send method not allowed error response
   */
  static methodNotAllowed(
    res: NextApiResponse,
    method: string,
    allowedMethods: string[]
  ): void {
    res.setHeader('Allow', allowedMethods.join(', '));
    this.error(
      res,
      ErrorCode.METHOD_NOT_ALLOWED,
      `Method ${method} not allowed. Allowed methods: ${allowedMethods.join(', ')}`
    );
  }

  /**
   * Send internal server error response
   */
  static internalError(
    res: NextApiResponse,
    error: Error | unknown,
    detailedMessage?: string
  ): void {
    log.error('Internal Server Error', error instanceof Error ? { message: error.message, stack: error.stack } : { error }, 'ApiResponse');

    const isDevelopment = process.env.NODE_ENV === 'development';
    const message = isDevelopment
      ? (detailedMessage || 'An internal error occurred')
      : 'An internal error occurred';
    const errorDetails = isDevelopment && error instanceof Error
      ? { stack: error.stack, originalMessage: error.message }
      : undefined;

    this.error(res, ErrorCode.INTERNAL_ERROR, message, errorDetails);
  }

  /**
   * Send database error response
   */
  static tooManyRequests(res: NextApiResponse, message = 'Rate limit exceeded'): void {
    this.error(res, ErrorCode.RATE_LIMIT, message);
  }

  static databaseError(
    res: NextApiResponse,
    error: Error | unknown,
    message = 'A database error occurred'
  ): void {
    log.error('Database Error', error instanceof Error ? { message: error.message } : { error }, 'ApiResponse');

    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorDetails = isDevelopment && error instanceof Error
      ? { originalMessage: error.message }
      : undefined;

    this.error(res, ErrorCode.DATABASE_ERROR, message, errorDetails);
  }

  /**
   * Handle CORS headers
   */
  static setCorsHeaders(
    res: NextApiResponse,
    origin = '',
    methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    headers = ['Content-Type', 'Authorization']
  ): void {
    // Shared allow-list in src/lib/cors.ts (pentest M11).
    const safeOrigin = safeCorsOrigin(origin);
    if (!safeOrigin) return;
    res.setHeader('Access-Control-Allow-Origin', safeOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
  }

  /**
   * Handle OPTIONS request for CORS
   */
  static handleOptions(req: NextApiRequest, res: NextApiResponse): void {
    this.setCorsHeaders(res, req.headers.origin || '');
    res.status(200).end();
  }
}

/**
 * Convenience exports for common responses
 */
export const apiResponse = {
  success: ApiResponseHelper.success.bind(ApiResponseHelper),
  created: ApiResponseHelper.created.bind(ApiResponseHelper),
  noContent: ApiResponseHelper.noContent.bind(ApiResponseHelper),
  paginated: ApiResponseHelper.paginated.bind(ApiResponseHelper),
  error: ApiResponseHelper.error.bind(ApiResponseHelper),
  badRequest: ApiResponseHelper.badRequest.bind(ApiResponseHelper),
  badRequestFromError: ApiResponseHelper.badRequestFromError.bind(ApiResponseHelper),
  validationError: ApiResponseHelper.validationError.bind(ApiResponseHelper),
  notFound: ApiResponseHelper.notFound.bind(ApiResponseHelper),
  unauthorized: ApiResponseHelper.unauthorized.bind(ApiResponseHelper),
  forbidden: ApiResponseHelper.forbidden.bind(ApiResponseHelper),
  paymentRequired: ApiResponseHelper.paymentRequired.bind(ApiResponseHelper),
  methodNotAllowed: ApiResponseHelper.methodNotAllowed.bind(ApiResponseHelper),
  internalError: ApiResponseHelper.internalError.bind(ApiResponseHelper),
  tooManyRequests: ApiResponseHelper.tooManyRequests.bind(ApiResponseHelper),
  databaseError: ApiResponseHelper.databaseError.bind(ApiResponseHelper),
  setCorsHeaders: ApiResponseHelper.setCorsHeaders.bind(ApiResponseHelper),
  handleOptions: ApiResponseHelper.handleOptions.bind(ApiResponseHelper),
};

export default apiResponse;
