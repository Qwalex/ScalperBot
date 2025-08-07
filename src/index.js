const logger = require('./logger');
const cfg = require('./config');
const BybitExchange = require('./exchange/bybit');
const SimpleScalper = require('./strategy/scalper');
const { startWebServer, updateStats } = require('./telemetry/web');

async function main() {
  logger.info({ env: process.env.NODE_ENV || 'dev', dryRun: cfg.dryRun, testnet: cfg.isTestnet }, 'Starting scalping bot');
  const ex = new BybitExchange(cfg);
  await ex.init();
  await ex.setLeverage(cfg.leverage);

  const strat = new SimpleScalper(ex, cfg);
  strat.start();

  // Запускаем веб-интерфейс на 3005
  startWebServer({ port: 3005 });

  // Подписка на приватные исполнения для статистики (если есть ключи)
  if (ex.wsPrivate) {
    ex.wsPrivate.on('update', (data) => {
      if (data?.topic !== 'execution') return;
      const list = Array.isArray(data.data) ? data.data : [];
      for (const x of list) {
        // Bybit V5 execution fields
        const fill = {
          symbol: x.symbol,
          side: x.side,
          qty: Number(x.execQty || x.qty || 0),
          price: Number(x.execPrice || x.price || 0),
          fee: Number(x.execFee || x.fee || 0),
          pnl: Number(x.execPnl || 0),
          ts: Number(x.execTime || x.ts || Date.now()),
        };
        updateStats(fill);
      }
    });
  }

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received, shutting down...');
    await ex.cancelAll();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.warn('SIGTERM received, shutting down...');
    await ex.cancelAll();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});

