import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Wrap an async route handler so rejected promises reach the Express error
// middleware instead of crashing the process with an unhandled rejection.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
