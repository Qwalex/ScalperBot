require('dotenv').config();

function getBooleanEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());
}

const config = {
  // API
  apiKey: process.env.BYBIT_KEY || '',
  apiSecret: process.env.BYBIT_SECRET || '',
  isTestnet: getBooleanEnv('BYBIT_TESTNET', true),

  // Trading
  category: process.env.CATEGORY || 'linear', // linear | inverse | spot | option
  symbol: process.env.SYMBOL || 'BTCUSDT',
  leverage: Number(process.env.LEVERAGE || 3),
  orderQty: Number(process.env.ORDER_QTY || 0.001),
  minSpreadTicks: Number(process.env.MIN_SPREAD_TICKS || 2),
  edgeTicks: Number(process.env.EDGE_TICKS || 2),
  minNetSpreadTicks: Number(process.env.MIN_NET_SPREAD_TICKS || 1),
  cancelAfterMs: Number(process.env.CANCEL_AFTER_MS || 2500),
  timeInForce: process.env.TIME_IN_FORCE || 'PostOnly', // GTC | IOC | FOK | PostOnly
  slippageToleranceType: process.env.SLIPPAGE_TOL_TYPE || 'TickSize', // TickSize | Percent
  slippageTolerance: process.env.SLIPPAGE_TOL || '10',
  positionMode: process.env.POSITION_MODE || 'OneWay', // OneWay | Hedge

  // Mode
  dryRun: getBooleanEnv('DRY_RUN', true),

  // Risk
  maxOpenOrders: Number(process.env.MAX_OPEN_ORDERS || 2),
};

module.exports = config;

