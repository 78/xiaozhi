const Emitter = require('events');
const AsrWorker = require('./worker');
const { WebSocketServer } = require('ws');
const config = require('./config');

class AsrWorkerManager extends Emitter {
  constructor() {
    super();
    this.workers = new Map();
    this.initTaskServer();
    this.startPingInterval();
  }

  initTaskServer() {
    this.taskServer = new WebSocketServer({ port: config.asrBackendPort });
    this.taskServer.on('connection', this.onConnection.bind(this));
    this.taskServer.on('error', this.onServerError.bind(this));
    this.taskServer.on('listening', this.onServerListening.bind(this));
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      this.workers.forEach(worker => worker.ws.ping());
    }, config.asrBackendPingInterval);
  }

  onServerError(err) {
    console.error(new Date(), 'ASR任务服务器错误:', err);
  }

  onServerListening() {
    console.log('ASR任务服务器正在监听端口', this.taskServer.options.port);
  }

  onConnection(ws, req) {
    const workerId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    console.log('ASR工作节点已连接:', workerId);

    const worker = new AsrWorker(ws, workerId);
    this.workers.set(workerId, worker);

    ws.on('close', () => this.onWorkerDisconnect(workerId));
  }

  onWorkerDisconnect(workerId) {
    console.log('ASR工作节点已断开连接:', workerId);
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.close();
      this.workers.delete(workerId);
    }
  }

  destroy() {
    clearInterval(this.pingInterval);
    this.taskServer.close();
    this.workers.forEach(worker => worker.close());
    this.workers.clear();
  }

  getWorker() {
    if (this.workers.size === 0) return null;
    const workers = Array.from(this.workers.values());
    return workers[Math.floor(Math.random() * workers.length)];
  }
}

module.exports = AsrWorkerManager;
