const logger = require('../logger');

class SimpleScalper {
  constructor(exchange, cfg) {
    this.ex = exchange;
    this.cfg = cfg;
    this.state = {
      bestBid: null,
      bestAsk: null,
      openOrders: new Map(), // orderId -> { side, price, ts }
    };
    this.timers = new Map();
  }

  start() {
    this.ex.subscribeOrderbookL1((ob) => this.onOrderbook(ob));
    if (this.ex.wsPrivate) this.ex.subscribePrivateOrder((evt) => this.onPrivateOrder(evt));
  }

  onPrivateOrder(evt) {
    const { orderId, orderStatus, side, price } = evt;
    if (!orderId) return;
    if (orderStatus === 'Filled' || orderStatus === 'Cancelled' || orderStatus === 'Rejected') {
      this.clearStale(orderId);
    }
    logger.debug({ orderStatus, side, price }, 'Private order update');
  }

  onOrderbook({ bestBid, bestAsk }) {
    this.state.bestBid = bestBid;
    this.state.bestAsk = bestAsk;
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
    const spread = bestAsk - bestBid;
    const tick = this.ex.instrument.tickSize;
    const spreadTicks = spread / tick;

    // Требуем минимальный исходный спред
    if (spreadTicks >= this.cfg.minSpreadTicks) {
      const edge = Math.max(1, this.cfg.edgeTicks || 1);
      const netSpreadTicks = spreadTicks - edge - edge; // после сдвига от краёв книги
      if (netSpreadTicks < this.cfg.minNetSpreadTicks) return;

      const buyPrice = bestBid + edge * tick;
      const sellPrice = bestAsk - edge * tick;
      this.quote('Buy', buyPrice);
      this.quote('Sell', sellPrice);
    }
  }

  async quote(side, price) {
    if (this.state.openOrders.size >= this.cfg.maxOpenOrders) return;
    try {
      const res = await this.ex.placeLimit({ side, price, qty: this.cfg.orderQty, timeInForce: this.cfg.timeInForce });
      const orderId = res?.orderId;
      if (!orderId) return;
      this.state.openOrders.set(orderId, { side, price, ts: Date.now() });
      const timer = setTimeout(() => this.cancelIfOpen(orderId), this.cfg.cancelAfterMs);
      this.timers.set(orderId, timer);
    } catch (err) {
      // Errors already logged inside exchange
    }
  }

  async cancelIfOpen(orderId) {
    try {
      await this.ex.cancelOrder(orderId);
    } finally {
      this.clearStale(orderId);
    }
  }

  clearStale(orderId) {
    if (this.timers.has(orderId)) {
      clearTimeout(this.timers.get(orderId));
      this.timers.delete(orderId);
    }
    this.state.openOrders.delete(orderId);
  }
}

module.exports = SimpleScalper;

