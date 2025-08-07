const logger = require('./logger');
const cfg = require('./config');
const BybitExchange = require('./exchange/bybit');
const SimpleScalper = require('./strategy/scalper');

async function main() {
  logger.info({ env: process.env.NODE_ENV || 'dev', dryRun: cfg.dryRun, testnet: cfg.isTestnet }, 'Starting scalping bot');
  const ex = new BybitExchange(cfg);
  await ex.init();
  await ex.setLeverage(cfg.leverage);

  const strat = new SimpleScalper(ex, cfg);
  strat.start();

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

