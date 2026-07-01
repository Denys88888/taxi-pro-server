import winston from 'winston';

// Structured logger. In production we emit JSON; locally we use a colorized,
// human-readable format. Never log secrets (JWTs, API keys, private keys).
const isProd = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isProd
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(
          ({ timestamp, level, message, ...meta }) =>
            `${timestamp} ${level} ${message}${
              Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''
            }`
        )
      ),
  transports: [new winston.transports.Console()],
});
