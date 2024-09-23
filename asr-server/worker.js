const Emitter = require('events');
const { v4: uuidv4 } = require('uuid');

class AsrWorkerSession extends Emitter {
  constructor(asrWorker) {
    super();
    this.asrWorker = asrWorker;
    this.sessionId = uuidv4();
    this.initializeBuffer();
  }

  initializeBuffer() {
    const sessionIdLength = Buffer.alloc(4);
    sessionIdLength.writeUInt32BE(this.sessionId.length, 0);
    this.sessionIdBuffer = Buffer.concat([sessionIdLength, Buffer.from(this.sessionId, 'utf-8')]);
    this.opusDataLengthBuffer = Buffer.alloc(4);
  }

  sendAudio(opusData) {
    this.opusDataLengthBuffer.writeUInt32BE(opusData.length, 0);
    // Create a new buffer: [sessionId length 4u, sessionId str, opusData length 4u, opusData]
    const buffer = Buffer.concat([this.sessionIdBuffer, this.opusDataLengthBuffer, opusData]);
    this.asrWorker.send(buffer, { binary: true });
  }

  detect(words) {
    this.sendCommand('detect', { words });
  }

  finish() {
    this.sendCommand('finish');
    this.asrWorker.removeSession(this.sessionId);
  }

  sendCommand(type, params = {}) {
    this.asrWorker.send(JSON.stringify({ type, session_id: this.sessionId, ...params }));
  }
}

class AsrWorker extends Emitter {
  constructor(ws, workerId) {
    super();
    this.sessions = new Map();
    this.workerId = workerId;
    this.ws = ws;
    this.initWebSocket();
  }

  initWebSocket() {
    this.ws.on('message', this.onMessage.bind(this));
    this.ws.on('close', this.onClose.bind(this));
    this.ws.on('error', this.onError.bind(this));
  }

  send(data) {
    this.ws.send(data);
  }

  onMessage(message) {
    try {
      const data = JSON.parse(message);
      const { type, content, session_id, embedding, url } = data;
      if (type === 'chat' && this.sessions.has(session_id)) {
        this.sessions.get(session_id).emit('text', content, embedding, url);
      }
    } catch (error) {
      console.error('解析消息时出错:', error);
    }
  }

  onClose() {
    this.emit('close');
  }

  onError(error) {
    console.error(`工作节点 ${this.workerId} 发生错误:`, error);
    this.emit('error', error);
  }

  newSession() {
    const session = new AsrWorkerSession(this);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  removeSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  close() {
    this.sessions.forEach(session => session.emit('close'));
    this.sessions.clear();
    this.ws.close();
  }
}

module.exports = AsrWorker;
