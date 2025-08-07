const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
const WebSocket = require('ws');
const bus = require('./eventBus');
const readline = require('readline');

function startWebServer({ port = 3005, logFile = path.join(process.cwd(), 'logs', 'app.log') } = {}) {
  // Простой HTTP сервер для статики из папки public
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    let pathname = parsed.pathname;
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(process.cwd(), 'public', pathname);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'text/javascript'
        : ext === '.css' ? 'text/css'
        : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  // WebSocket: /ws
  // Если приложение висит за префиксом (/scalper/), то WS путь должен быть тем же
  // HTTP отдаёт под любым префиксом, а WS путь читаем из запроса — оставим '/ws' и доверим nginx проксировать /scalper/ws -> /ws
  const wss = new WebSocket.Server({ server, path: '/ws' });

  function send(ws, type, payload) {
    try { ws.send(JSON.stringify({ type, payload })); } catch {}
  }

  // При старте сервера — «подписываемся» на файл логов и стримим новые строки всем клиентам
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {}
  const ensureLogFile = () => { try { fs.closeSync(fs.openSync(logFile, 'a')); } catch {} };
  ensureLogFile();
  const logStream = fs.createReadStream(logFile, { encoding: 'utf8', flags: 'r' });
  const rl = readline.createInterface({ input: logStream });
  rl.on('line', (line) => {
    try { const obj = JSON.parse(line); broadcast('log', obj); } catch {}
  });
  function broadcast(type, payload) { for (const client of wss.clients) { if (client.readyState === WebSocket.OPEN) send(client, type, payload); } }

  wss.on('connection', (ws) => {
    // При подключении — отправим текущую статистику
    send(ws, 'stats', getStatsSnapshot());
    // и сразу же исторические логи из файла
    try {
      const data = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-500);
      for (const line of data) {
        try { const obj = JSON.parse(line); send(ws, 'log', obj); } catch {}
      }
    } catch {}
    const logHandler = (entry) => send(ws, 'log', entry);
    const statsHandler = (snapshot) => send(ws, 'stats', snapshot);
    bus.on('log', logHandler);
    bus.on('stats', statsHandler);
    ws.on('close', () => {
      bus.off('log', logHandler);
      bus.off('stats', statsHandler);
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[web] listening on http://localhost:${port}`);
  });
}

// Глобальная статистика — хранится здесь, обновляется из strategy/exchange
const stats = {
  symbol: null,
  trades: 0,
  filledQty: 0,
  realizedPnl: 0,
  fees: 0,
  lastFills: [], // последние N исполнений
};

function getStatsSnapshot() {
  return { ...stats, lastFills: stats.lastFills.slice(-50) };
}

function updateStats(fill) {
  // fill: { symbol, side, qty, price, fee, pnl, ts }
  if (fill?.symbol) stats.symbol = fill.symbol;
  stats.trades += 1;
  if (Number.isFinite(fill?.qty)) stats.filledQty += Number(fill.qty);
  if (Number.isFinite(fill?.pnl)) stats.realizedPnl += Number(fill.pnl);
  if (Number.isFinite(fill?.fee)) stats.fees += Number(fill.fee);
  stats.lastFills.push(fill);
  bus.emit('stats', getStatsSnapshot());
}

module.exports = { startWebServer, updateStats, getStatsSnapshot };


