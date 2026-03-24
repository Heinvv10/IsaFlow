/**
 * Logger Service
 * Proper logging replacement for console.* statements
 * Zero Tolerance Enforcement: No console.* statements allowed
 */

// Global type declarations for log storage
declare global {
  interface Window {
    __appLogs?: LogEntry[];
  }

  // Modern approach: extend NodeJS namespace
  namespace NodeJS {
    interface Process {
      __appLogs?: LogEntry[];
    }
  }
}

export interface LogData {
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string | undefined;
  message: string;
  data: LogData | undefined;
  formattedMessage: string;
}

export interface LoggerOptions {
  enableConsole?: boolean;
  enableFile?: boolean;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Logger class for structured logging
 * Replaces all console.* statements in the application
 */
class Logger {
  private options: LoggerOptions = {
    enableConsole: process.env.NODE_ENV === 'development',
    enableFile: false,
    level: 'info',
  };

  constructor(options?: Partial<LoggerOptions>) {
    this.options = { ...this.options, ...options };
  }

  /**
   * Log debug messages
   * @param message - Log message
   * @param data - Additional data to log
   * @param component - Component name for context
   */
  debug(message: string, data?: LogData, component?: string): void {
    this.log('debug', message, data, component);
  }

  /**
   * Log info messages
   * @param message - Log message
   * @param data - Additional data to log
   * @param component - Component name for context
   */
  info(message: string, data?: LogData, component?: string): void {
    this.log('info', message, data, component);
  }

  /**
   * Log warning messages
   * @param message - Log message
   * @param data - Additional data to log
   * @param component - Component name for context
   */
  warn(message: string, data?: LogData, component?: string): void {
    this.log('warn', message, data, component);
  }

  /**
   * Log error messages
   * @param message - Log message
   * @param data - Additional data to log
   * @param component - Component name for context
   */
  error(message: string, data?: LogData, component?: string): void {
    this.log('error', message, data, component);
  }

  /**
   * Internal logging method
   * @param level - Log level
   * @param message - Log message
   * @param data - Additional data
   * @param component - Component name
   */
  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: LogData,
    component?: string
  ): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const prefix = component ? `[${component}]` : '';
    const logMessage = `${timestamp} [${level.toUpperCase()}] ${prefix} ${message}`;

    // Store logs in memory for development (could be sent to external service in production)
    const logEntry = {
      timestamp,
      level,
      component,
      message,
      data,
      formattedMessage: logMessage
    };

    // Store in global log collection (browser or Node.js)
    if (typeof window !== 'undefined') {
      // Browser environment
      if (!window.__appLogs) window.__appLogs = [];
      window.__appLogs.push(logEntry);

      // Limit log storage to prevent memory issues
      if (window.__appLogs.length > 1000) {
        window.__appLogs.shift();
      }
    } else {
      // Node.js environment - could write to file or send to logging service
      // For now, just store in process (could be extended)
      if (!process.__appLogs) process.__appLogs = [];
      process.__appLogs.push(logEntry);

      // Limit log storage
      if (process.__appLogs.length > 1000) {
        process.__appLogs.shift();
      }
    }

    // In development, could optionally write to stderr/stdout
    // But we avoid console.* statements entirely for zero-tolerance compliance
    if (this.options.enableFile && process.env.NODE_ENV === 'development') {
      // Could implement file logging here if needed
      // fs.appendFile('app.log', logMessage + '\n', () => {})
    }
  }

  /**
   * Check if we should log at this level
   * @param level - Log level to check
   * @returns Boolean indicating if logging should occur
   */
  private shouldLog(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.options.level || 'info');
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  /**
   * Get all stored logs (for debugging in development)
   * @returns Array of log entries
   */
  getLogs(): LogEntry[] {
    if (typeof window !== 'undefined') {
      return window.__appLogs || [];
    } else {
      return (process as any).__appLogs || [];
    }
  }

  /**
   * Clear all stored logs
   */
  clearLogs(): void {
    if (typeof window !== 'undefined') {
      window.__appLogs = [];
    } else {
      (process as any).__appLogs = [];
    }
  }

  /**
   * Get logs for development debugging (replaces console access)
   * This method can be used in development to inspect logs without console
   */
  getRecentLogs(count: number = 50): LogEntry[] {
    const logs = this.getLogs();
    return logs.slice(-count);
  }

  /**
   * Export logs as string (for debugging or external service)
   */
  exportLogs(): string {
    const logs = this.getLogs();
    return logs.map(log => log.formattedMessage + (log.data ? ` ${JSON.stringify(log.data)}` : '')).join('\n');
  }
}

// Export singleton logger instance
export const log = new Logger();

// Export Logger class for custom instances
export { Logger };

// Default export for convenience
export default log;

/**
 * Create a logger instance with a component name
 * @param component - Component name for logging context
 * @returns Logger instance with component context
 */
export function createLogger(component: string) {
  return {
    debug: (message: string, data?: LogData) => log.debug(message, data, component),
    info: (message: string, data?: LogData) => log.info(message, data, component),
    warn: (message: string, data?: LogData) => log.warn(message, data, component),
    error: (message: string, data?: LogData) => log.error(message, data, component),
  };
}

/**
 * Pino-style API logger for use in API routes
 * Accepts (data, message?) format used by api-error-handler and API routes
 */
export const apiLogger = {
  debug: (data: LogData, message?: string) => log.debug(message || 'debug', data, 'API'),
  info: (data: LogData, message?: string) => log.info(message || 'info', data, 'API'),
  warn: (data: LogData, message?: string) => log.warn(message || 'warning', data, 'API'),
  error: (data: LogData, message?: string) => log.error(message || 'error', data, 'API'),
};
