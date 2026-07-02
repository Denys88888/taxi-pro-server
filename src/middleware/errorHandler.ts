import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

interface HttpError extends Error {
  statusCode?: number;
}

// 404 for unmatched routes.
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

// Global error handler. Logs the error and returns a safe JSON response. Never
// leaks stack traces or secrets to the client.
export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    logger.error('[Error]', { message: err.message, stack: err.stack });
  } else {
    logger.warn('[Error]', { message: err.message, status });
  }
  // Only mask truly unexpected 500s. Explicit operational errors (e.g. 503 when
  // the Pi API key isn't configured) keep their message so clients can react.
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
}
