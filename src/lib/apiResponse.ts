import { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';

/**
 * Standard API Response Types
 */
export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
  meta?: {
    timestamp?: string;
    requestId?: string;
    [key: string]: any;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    timestamp?: string;
    requestId?: string;
    [key: string]: any;
  };
}

export interface ApiPaginatedResponse<T = any> extends ApiSuccessResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Standard error codes
 */
export enum ErrorCode {
  // Client errors (400-499)
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

  // Server errors (500-599)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',

  // Business logic errors
  BUSINESS_RULE_VIOLATION = 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  RESOURCE_LOCKED = 'RESOURCE_LOCKED',
  DEPENDENCY_ERROR = 'DEPENDENCY_ERROR',
}

/**
 * HTTP status code mapping
 */
const STATUS_CODE_MAP: Record<ErrorCode, number> = {
  // Client errors
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.METHOD_NOT_ALLOWED]: 405,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.RATE_LIMIT]: 429,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,

  // Server errors
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.GATEWAY_TIMEOUT]: 504,

  // Business logic errors (usually 400 or 422)
  [ErrorCode.BUSINESS_RULE_VIOLATION]: 422,
  [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,
  [ErrorCode.RESOURCE_LOCKED]: 423,
  [ErrorCode.DEPENDENCY_ERROR]: 424,
};

/**
 * API Response Helper Class
 */
export class ApiResponseHelper {
  private static generateMeta(additionalMeta?: Record<string, any>) {
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
    meta?: Record<string, any>
  ): void {
    const response: ApiSuccessResponse<T> = {
      success: true,
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
    meta?: Record<string, any>
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
    meta?: Record<string, any>
  ): void {
    const totalPages = Math.ceil(pagination.total / pagination.pageSize);

    const response: ApiPaginatedResponse<T> = {
      success: true,
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
    details?: any,
    meta?: Record<string, any>
  ): void {
    const statusCode = STATUS_CODE_MAP[code] || 500;

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code,
        message,
        ...(details && { details }),
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
    details?: any
  ): void {
    this.error(res, ErrorCode.BAD_REQUEST, message, details);
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
    message = 'An internal error occurred'
  ): void {
    // Log the actual error for debugging
    log.error('Internal Server Error', error instanceof Error ? { message: error.message, stack: error.stack } : { error }, 'ApiResponse');

    // In production, don't expose internal error details
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorDetails = isDevelopment && error instanceof Error
      ? { stack: error.stack, originalMessage: error.message }
      : undefined;

    this.error(res, ErrorCode.INTERNAL_ERROR, message, errorDetails);
  }

  /**
   * Send database error response
   */
  static databaseError(
    res: NextApiResponse,
    error: Error | unknown,
    message = 'A database error occurred'
  ): void {
    // Log the actual error for debugging
    log.error('Database Error', error instanceof Error ? { message: error.message } : { error }, 'ApiResponse');

    // In production, don't expose database error details
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
    const allowedOrigins = [
      'https://accounting.fibreflow.app',
      // dev
      'http://localhost:3006',
      'http://localhost:3004',
    ];
    const safeOrigin = origin && allowedOrigins.includes(origin) ? origin : '';
    if (!safeOrigin) return;
    res.setHeader('Access-Control-Allow-Origin', safeOrigin);
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
  validationError: ApiResponseHelper.validationError.bind(ApiResponseHelper),
  notFound: ApiResponseHelper.notFound.bind(ApiResponseHelper),
  unauthorized: ApiResponseHelper.unauthorized.bind(ApiResponseHelper),
  forbidden: ApiResponseHelper.forbidden.bind(ApiResponseHelper),
  methodNotAllowed: ApiResponseHelper.methodNotAllowed.bind(ApiResponseHelper),
  internalError: ApiResponseHelper.internalError.bind(ApiResponseHelper),
  databaseError: ApiResponseHelper.databaseError.bind(ApiResponseHelper),
  setCorsHeaders: ApiResponseHelper.setCorsHeaders.bind(ApiResponseHelper),
  handleOptions: ApiResponseHelper.handleOptions.bind(ApiResponseHelper),
};

export default apiResponse;
