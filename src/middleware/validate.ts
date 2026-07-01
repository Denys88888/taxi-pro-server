import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';

type Source = 'body' | 'query' | 'params';

// Validate a request segment against a Zod schema. On success the parsed value
// replaces the original (coerced/stripped); on failure responds 400 with details.
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[source]);
      // req.query/params are read-only getters in Express 5-ish typings; assign safely.
      Object.defineProperty(req, source, { value: parsed, configurable: true });
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
        return;
      }
      next(err);
    }
  };
}
