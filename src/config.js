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
  sizeImbalanceTolerance: Number(process.env.SIZE_IMBALANCE_TOL || 0.3),
  cancelAfterMs: Number(process.env.CANCEL_AFTER_MS || 2500),
  timeInForce: process.env.TIME_IN_FORCE || 'PostOnly', // GTC | IOC | FOK | PostOnly
  slippageToleranceType: process.env.SLIPPAGE_TOL_TYPE || 'TickSize', // TickSize | Percent
  slippageTolerance: process.env.SLIPPAGE_TOL || '10',
  positionMode: process.env.POSITION_MODE || 'OneWay', // OneWay | Hedge
  tradeAggWindowMs: Number(process.env.TRADE_AGG_WINDOW_MS || 1000),
  aggressorBiasTol: Number(process.env.AGGRESSOR_BIAS_TOL || 0.3),

  // Volatility & dynamic edge
  volWindowMs: Number(process.env.VOL_WINDOW_MS || 30000),
  volMin: Number(process.env.VOL_MIN || 0),
  volMax: Number(process.env.VOL_MAX || 1e9),
  dynEdgeBase: Number(process.env.DYN_EDGE_BASE || 2),
  dynEdgeMax: Number(process.env.DYN_EDGE_MAX || 8),
  dynEdgeVolScale: Number(process.env.DYN_EDGE_VOL_SCALE || 4),

  // Breakout/momentum
  breakoutWindowMs: Number(process.env.BREAKOUT_WINDOW_MS || 15000),
  breakoutMinTrades: Number(process.env.BREAKOUT_MIN_TRADES || 10),
  minExpectedProfitTicks: Number(process.env.MIN_EXPECTED_PROFIT_TICKS || 1),

  // Mode
  dryRun: getBooleanEnv('DRY_RUN', true),

  // Risk
  maxOpenOrders: Number(process.env.MAX_OPEN_ORDERS || 2),
  maxOrdersPerMinute: Number(process.env.MAX_ORDERS_PER_MINUTE || 30),
  globalCooldownMs: Number(process.env.GLOBAL_COOLDOWN_MS || 0),
};

module.exports = config;

