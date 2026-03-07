import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

export const loggerOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Cloud Run expects structured JSON logs in production
  formatters: {
    level: (label: string) => ({ severity: label.toUpperCase() }),
  },
} as const;

export const logger = pino(loggerOptions);

export default logger;
