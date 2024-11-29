const config = require('./config');
const { WebSocketServer } = require('ws');
const { OpusEncoder } = require('@discordjs/opus');
const AsrWorkerManager = require('./manager');

const wss = new WebSocketServer({ port: config.asrFrontendPort });
const manager = new AsrWorkerManager();

wss.on('connection', (ws) => {
  const worker = manager.getWorker();
  if (!worker) {
    console.error('没有可用的ASR工作节点');
    ws.close();
    return;
  }

  const closeHandler = () => {
    ws.close();
  };

  worker.on('close', closeHandler);

  const decoder = new OpusEncoder(config.decodeSampleRate, 1);
  const session = worker.newSession();
  session.on('text', (text, embedding, url) => {
    ws.send(JSON.stringify({ type: 'text', text, embedding, url }));
  });

  ws.on('message', (message, isBinary) => {
    try {
      if (isBinary) {
        const data = decoder.decode(message);
        session.sendAudio(data);
      } else {
        const json = JSON.parse(message);
        if (json.type === 'listen') {
          session.sendJson(json);
        } else {
          console.error('收到未知消息类型:', json.type);
        }
      }
    } catch (err) {
      console.error('处理消息时出错:', err);
    }
  });

  ws.on('close', () => {
    session.finish();
    worker.removeListener('close', closeHandler);
  });
});

wss.on('listening', () => {
  console.log('ASR前端服务器正在监听端口', wss.options.port);
});


