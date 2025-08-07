const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const pretty = process.env.LOG_PRETTY === '1' || process.env.LOG_PRETTY === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isProd || !pretty
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

module.exports = logger;

