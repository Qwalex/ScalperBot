const EventEmitter = require('events');

// Глобальная шина событий приложения (логи, статистика и т.п.)
class AppEventBus extends EventEmitter {}

module.exports = new AppEventBus();


