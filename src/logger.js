const pino = require('pino');
const fs = require('fs');
const path = require('path');
const bus = require('./telemetry/eventBus');

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

// Файловый лог: всегда пишем JSON строки в LOG_FILE (по умолчанию logs/app.log)
const LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), 'logs', 'app.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
const fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function writeFileLine(level, msg, data) {
  const entry = { time: Date.now(), level, msg, data };
  try { fileStream.write(JSON.stringify(entry) + '\n'); } catch {}
}

// Переотправляем логи в веб‑шину. Pino позволяет использовать hooks через destination/transport,
// но для простоты — monkey-patch write.
const baseChild = logger.child.bind(logger);
logger.child = function patchedChild(bindings) {
  const child = baseChild(bindings);
  const baseInfo = child.info.bind(child);
  const baseWarn = child.warn.bind(child);
  const baseError = child.error.bind(child);
  const baseDebug = child.debug.bind(child);
  function emit(level, msg, data) {
    const t = Date.now();
    const entry = { level, msg, data, time: t };
    bus.emit('log', entry);
    writeFileLine(level, msg, data);
  }
  child.info = (obj, msg) => { emit('info', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseInfo(obj, msg); };
  child.warn = (obj, msg) => { emit('warn', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseWarn(obj, msg); };
  child.error = (obj, msg) => { emit('error', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseError(obj, msg); };
  child.debug = (obj, msg) => { emit('debug', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseDebug(obj, msg); };
  return child;
};

// Также эмитим из корневого логгера
const baseInfo = logger.info.bind(logger);
const baseWarn = logger.warn.bind(logger);
const baseError = logger.error.bind(logger);
const baseDebug = logger.debug.bind(logger);
function emit(level, msg, data) {
  const t = Date.now();
  const entry = { level, msg, data, time: t };
  bus.emit('log', entry);
  writeFileLine(level, msg, data);
}
logger.info = (obj, msg) => { emit('info', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseInfo(obj, msg); };
logger.warn = (obj, msg) => { emit('warn', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseWarn(obj, msg); };
logger.error = (obj, msg) => { emit('error', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseError(obj, msg); };
logger.debug = (obj, msg) => { emit('debug', msg || (typeof obj === 'string' ? obj : ''), typeof obj === 'object' ? obj : undefined); return baseDebug(obj, msg); };

module.exports = logger;

