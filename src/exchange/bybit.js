const { RestClientV5, WebsocketClient } = require('bybit-api');
const Bottleneck = require('bottleneck');
const logger = require('../logger');

class BybitExchange {
  constructor(cfg) {
    this.cfg = cfg;
    this.rest = new RestClientV5({
      key: cfg.apiKey || undefined,
      secret: cfg.apiSecret || undefined,
      testnet: cfg.isTestnet,
    });

    this.wsPublic = new WebsocketClient({
      testnet: cfg.isTestnet,
    });

    this.wsPrivate = cfg.apiKey && cfg.apiSecret
      ? new WebsocketClient({
          key: cfg.apiKey,
          secret: cfg.apiSecret,
          testnet: cfg.isTestnet,
        })
      : null;

    this.rateLimiter = new Bottleneck({
      minTime: 120, // ~8 req/s ceiling for safety
      maxConcurrent: 1,
    });

    this.instrument = null; // { tickSize, qtyStep, minOrderQty }
  }

  async init() {
    await this.fetchInstrument();
    if (!this.instrument) throw new Error('No instrument info fetched');
  }

  async fetchInstrument() {
    try {
      const res = await this.rest.getInstrumentsInfo({
        category: this.cfg.category,
        symbol: this.cfg.symbol,
      });
      const info = res?.result?.list?.[0];
      if (!info) throw new Error('Instrument not found');
      const tickSize = Number(info.priceFilter?.tickSize || '0.5');
      const qtyStep = Number(info.lotSizeFilter?.qtyStep || '0.001');
      const minOrderQty = Number(info.lotSizeFilter?.minOrderQty || '0.001');
      this.instrument = { tickSize, qtyStep, minOrderQty };
      logger.info({ tickSize, qtyStep, minOrderQty }, 'Instrument loaded');
    } catch (err) {
      logger.error({ err }, 'Failed to fetch instrument info');
      throw err;
    }
  }

  roundPrice(price) {
    const { tickSize } = this.instrument;
    const p = Math.round(price / tickSize) * tickSize;
    return Number(p.toFixed(this.decimals(tickSize)));
  }

  roundQty(qty) {
    const { qtyStep, minOrderQty } = this.instrument;
    const q = Math.max(minOrderQty, Math.floor(qty / qtyStep) * qtyStep);
    return Number(q.toFixed(this.decimals(qtyStep)));
  }

  decimals(step) {
    const s = String(step);
    const idx = s.indexOf('.');
    return idx === -1 ? 0 : s.length - idx - 1;
  }

  subscribeOrderbookL1(onUpdate) {
    const topic = `orderbook.1.${this.cfg.symbol}`;
    this.wsPublic.subscribeV5([topic], this.cfg.category);
    this.wsPublic.on('update', (data) => {
      if (!data || data.topic !== topic) return;
      try {
        const payload = data.data;
        // For L1, Bybit sends snapshot only: payload has b (best bid), a (best ask)
        const bestBid = Number(payload?.b?.[0]?.[0]);
        const bidSize = Number(payload?.b?.[0]?.[1]);
        const bestAsk = Number(payload?.a?.[0]?.[0]);
        const askSize = Number(payload?.a?.[0]?.[1]);
        if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) onUpdate({ bestBid, bestAsk, bidSize, askSize, ts: data.ts });
      } catch {}
    });

    this.wsPublic.on('open', ({ wsKey }) => logger.info({ wsKey }, 'WS public connected'));
    this.wsPublic.on('close', ({ wsKey }) => logger.warn({ wsKey }, 'WS public closed'));
    this.wsPublic.on('exception', (err) => logger.error({ err }, 'WS public exception'));
    this.wsPublic.on('error', (err) => logger.error({ err }, 'WS public error'));
  }

  subscribePublicTrades(onTrades) {
    const topic = `publicTrade.${this.cfg.symbol}`;
    this.wsPublic.subscribeV5([topic], this.cfg.category);
    this.wsPublic.on('update', (data) => {
      if (!data || data.topic !== topic) return;
      try {
        const list = Array.isArray(data.data) ? data.data : [];
        if (list.length === 0) return;
        const trades = list.map((t) => ({
          side: t.S || t.side,
          price: Number(t.p || t.price),
          qty: Number(t.v || t.qty),
          ts: Number(t.T || t.ts || data.ts),
        })).filter((t) => Number.isFinite(t.price) && Number.isFinite(t.qty) && Number.isFinite(t.ts));
        if (trades.length) onTrades(trades);
      } catch {}
    });
  }

  subscribePrivateOrder(onOrder) {
    if (!this.wsPrivate) return;
    const args = ['order'];
    this.wsPrivate.subscribeV5(args, this.cfg.category);
    this.wsPrivate.on('update', (data) => {
      if (!data || data.topic !== 'order') return;
      const events = Array.isArray(data.data) ? data.data : [];
      events.forEach(onOrder);
    });
    this.wsPrivate.on('open', ({ wsKey }) => logger.info({ wsKey }, 'WS private connected'));
    this.wsPrivate.on('close', ({ wsKey }) => logger.warn({ wsKey }, 'WS private closed'));
    this.wsPrivate.on('exception', (err) => logger.error({ err }, 'WS private exception'));
    this.wsPrivate.on('error', (err) => logger.error({ err }, 'WS private error'));
  }

  async setLeverage(leverage) {
    try {
      if (this.cfg.category !== 'linear' && this.cfg.category !== 'inverse') return;
      if (this.cfg.dryRun) return;
      await this.rateLimiter.schedule(() =>
        this.rest.setLeverage({
          category: this.cfg.category,
          symbol: this.cfg.symbol,
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        })
      );
      logger.info({ leverage }, 'Leverage set');
    } catch (err) {
      logger.error({ err }, 'Failed to set leverage');
    }
  }

  async placeLimit({ side, price, qty, timeInForce = this.cfg.timeInForce, reduceOnly = false }) {
    const roundedPrice = this.roundPrice(price);
    const roundedQty = this.roundQty(qty);
    if (this.cfg.dryRun) {
      logger.info({ side, roundedPrice, roundedQty, timeInForce }, 'DRY_RUN place limit');
      return { orderId: 'dry-run', orderLinkId: '' };
    }
    try {
      const orderLinkId = `scalp-${Date.now()}-${side}`;
      const res = await this.rateLimiter.schedule(() =>
        this.rest.submitOrder({
          category: this.cfg.category,
          symbol: this.cfg.symbol,
          side: side === 'Buy' ? 'Buy' : 'Sell',
          orderType: 'Limit',
          qty: String(roundedQty),
          price: String(roundedPrice),
          timeInForce,
          reduceOnly,
          orderLinkId,
        })
      );
      const { retCode, retMsg, result: data } = res || {};
      if (retCode !== 0) {
        logger.error({ retCode, retMsg, side, roundedPrice, roundedQty }, 'Order not accepted');
        throw new Error(`Order rejected: ${retCode} ${retMsg}`);
      }
      logger.info({ side, roundedPrice, roundedQty, orderId: data?.orderId, orderLinkId }, 'Order placed');
      return { ...data, orderLinkId };
    } catch (err) {
      logger.error({ err }, 'Failed to place limit order');
      throw err;
    }
  }

  async cancelOrder(ref) {
    if (this.cfg.dryRun) {
      logger.info({ ref }, 'DRY_RUN cancel');
      return;
    }
    try {
      const params = { category: this.cfg.category, symbol: this.cfg.symbol };
      if (typeof ref === 'string') {
        params.orderId = ref;
      } else if (ref?.orderId) {
        params.orderId = ref.orderId;
      } else if (ref?.orderLinkId) {
        params.orderLinkId = ref.orderLinkId;
      }
      await this.rateLimiter.schedule(() => this.rest.cancelOrder(params));
      logger.info({ ref }, 'Order cancelled');
    } catch (err) {
      logger.error({ err, ref }, 'Failed to cancel order');
    }
  }

  async cancelAll() {
    if (this.cfg.dryRun) return;
    try {
      await this.rateLimiter.schedule(() =>
        this.rest.cancelAllOrders({ category: this.cfg.category, symbol: this.cfg.symbol })
      );
      logger.info('Cancelled all open orders');
    } catch (err) {
      logger.error({ err }, 'Failed to cancel all orders');
    }
  }
}

module.exports = BybitExchange;

