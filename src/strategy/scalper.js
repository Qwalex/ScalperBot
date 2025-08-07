const logger = require('../logger');

class SimpleScalper {
  constructor(exchange, cfg) {
    this.ex = exchange;
    this.cfg = cfg;
    this.state = {
      bestBid: null,
      bestAsk: null,
      openOrders: new Map(), // orderId -> { side, price, ts }
      recentAgg: { // агрессия покупок/продаж за короткое окно
        buyVol: 0,
        sellVol: 0,
        lastReset: Date.now(),
      },
      vol: { // простая оценка волатильности в тиках за окно
        window: [], // { ts, price }
        lastPrice: null,
        realized: 0,
        lastComputed: 0,
      },
      breakout: {
        window: [], // { ts, price }
      },
      orderTimes: [],
      cooldownUntil: 0,
    };
    this.timers = new Map();
  }

  start() {
    this.ex.subscribeOrderbookL1((ob) => this.onOrderbook(ob));
    if (this.ex.wsPrivate) this.ex.subscribePrivateOrder((evt) => this.onPrivateOrder(evt));
    this.ex.subscribePublicTrades((trades) => this.onPublicTrades(trades));
  }

  onPrivateOrder(evt) {
    const { orderId, orderStatus, side, price } = evt;
    if (!orderId) return;
    if (orderStatus === 'Filled' || orderStatus === 'Cancelled' || orderStatus === 'Rejected') {
      this.clearStale(orderId);
    }
    logger.debug({ orderStatus, side, price }, 'Private order update');
  }

  onPublicTrades(trades) {
    // накапливаем агрессию за короткое окно (например, 1000 мс), чтобы избегать котирования против импульса
    const now = Date.now();
    const windowMs = this.cfg.tradeAggWindowMs || 1000;
    if (now - this.state.recentAgg.lastReset > windowMs) {
      this.state.recentAgg = { buyVol: 0, sellVol: 0, lastReset: now };
    }
    for (const t of trades) {
      if (t.side === 'Buy') this.state.recentAgg.buyVol += t.qty;
      else if (t.side === 'Sell') this.state.recentAgg.sellVol += t.qty;
    }

    // обновим цены для волы/брейкаута
    const v = this.state.vol;
    const br = this.state.breakout;
    const volWin = this.cfg.volWindowMs || 30000;
    const brWin = this.cfg.breakoutWindowMs || 15000;
    for (const t of trades) {
      const p = t.price;
      v.window.push({ ts: t.ts || now, price: p });
      br.window.push({ ts: t.ts || now, price: p });
    }
    // очистка окон
    const nowTs = Date.now();
    v.window = v.window.filter((x) => nowTs - x.ts <= volWin);
    br.window = br.window.filter((x) => nowTs - x.ts <= brWin);
    // простая realized-vol: среднее абсолютное приращение в тиках
    if (nowTs - v.lastComputed > 300) {
      const tick = this.ex.instrument?.tickSize || 1;
      let sumAbs = 0; let cnt = 0;
      for (let i = 1; i < v.window.length; i++) {
        const dp = Math.abs(v.window[i].price - v.window[i - 1].price) / tick;
        if (Number.isFinite(dp)) { sumAbs += dp; cnt++; }
      }
      v.realized = cnt > 0 ? sumAbs / cnt : 0;
      v.lastComputed = nowTs;
    }
  }

  onOrderbook({ bestBid, bestAsk, bidSize, askSize }) {
    this.state.bestBid = bestBid;
    this.state.bestAsk = bestAsk;
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
    const spread = bestAsk - bestBid;
    const tick = this.ex.instrument.tickSize;
    const spreadTicks = spread / tick;

    // Простейшая микроструктурная эвристика: фильтруем, если на ask明显 больше ликвидности, чем на bid (или наоборот)
    // Поддерживает смещение стороны в сторону перевеса стакана.
    // Коэффициент асимметрии ликвидности
    const sizeImbalance = Number.isFinite(bidSize) && Number.isFinite(askSize) && (bidSize + askSize > 0)
      ? (bidSize - askSize) / (bidSize + askSize)
      : 0;

    // Требуем минимальный исходный спред
    if (spreadTicks >= this.cfg.minSpreadTicks) {
      // динамический edge от волатильности
      const vol = this.state.vol.realized || 0;
      const base = Math.max(1, this.cfg.dynEdgeBase || this.cfg.edgeTicks || 1);
      const maxE = Math.max(base, this.cfg.dynEdgeMax || base + 6);
      const scale = Math.max(1, this.cfg.dynEdgeVolScale || 4);
      const edge = Math.min(maxE, Math.round(base + vol / scale));
      const netSpreadTicks = spreadTicks - edge - edge; // после сдвига от краёв книги
      if (netSpreadTicks < this.cfg.minNetSpreadTicks) return;

      // Усиление консерватизма: если перевес на ask, не ставим buy; если на bid — не ставим sell
      let buyAllowed = sizeImbalance >= -this.cfg.sizeImbalanceTolerance;
      let sellAllowed = sizeImbalance <= this.cfg.sizeImbalanceTolerance;

      // фильтр по агрессору последних тиков
      const totalAgg = this.state.recentAgg.buyVol + this.state.recentAgg.sellVol;
      if (totalAgg > 0) {
        const aggressorBias = (this.state.recentAgg.buyVol - this.state.recentAgg.sellVol) / totalAgg; // [-1..1]
        if (aggressorBias > (this.cfg.aggressorBiasTol || 0.3)) {
          // доминируют покупатели — режем Sell
          sellAllowed = false;
        } else if (aggressorBias < -(this.cfg.aggressorBiasTol || 0.3)) {
          // доминируют продавцы — режем Buy
          buyAllowed = false;
        }
      }

      const buyPrice = bestBid + edge * tick;
      const sellPrice = bestAsk - edge * tick;
      // проверка ожидаемого чистого профита в тиках
      if (netSpreadTicks < (this.cfg.minExpectedProfitTicks || 1)) return;
      if (buyAllowed) this.quote('Buy', buyPrice);
      if (sellAllowed) this.quote('Sell', sellPrice);
    }
  }

  async quote(side, price) {
    if (this.state.openOrders.size >= this.cfg.maxOpenOrders) return;
    const now = Date.now();
    if (now < this.state.cooldownUntil) return;
    const perMin = this.cfg.maxOrdersPerMinute || 30;
    this.state.orderTimes = this.state.orderTimes.filter((t) => now - t <= 60000);
    if (this.state.orderTimes.length >= perMin) return;
    try {
      const res = await this.ex.placeLimit({ side, price, qty: this.cfg.orderQty, timeInForce: this.cfg.timeInForce });
      const orderId = res?.orderId;
      if (!orderId) return;
      this.state.orderTimes.push(now);
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

