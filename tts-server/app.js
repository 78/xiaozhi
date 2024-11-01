const WebSocket = require('ws');
const config = require('./config');
const { OpusEncoder } = require('@discordjs/opus');
const { ttsList } = require('./tts-list');
const { BytedanceTtsClient } = require('./bytedance_tts');
const { DashscopeTtsClient } = require('./dashscope_tts');

const ttsClients = {
  volcengine: BytedanceTtsClient,
  dashscope: DashscopeTtsClient,
};

class TtsSessionHandler {
  constructor(ws) {
    this.ws = ws;
    this.sampleRate = config.encodeSampleRate;
    this.queueEvents = [];
  }

  reset() {
    this.encoder = new OpusEncoder(this.sampleRate, 1);
    this.encoder.applyEncoderCTL(4000, 2048); // VOIP
    this.encodeFrameSize = this.sampleRate / 1000 * config.encodeIntervalMs;
    this.outputBuffer = Buffer.alloc(0);
    this.outputPosition = 0;
    this.audioTimestamp = 0;
    this.ttsErrorCount = 0;
    this.session = null;
    this.voice = null;
    this.finished = false;
    this.replyText = '';
  }

  encodeAudio(pcm) {
    this.outputBuffer = Buffer.concat([this.outputBuffer, pcm]);
    const pieceLength = this.encodeFrameSize * 2;
    while (this.outputBuffer.length - this.outputPosition >= pieceLength) {
      const frame = this.outputBuffer.subarray(this.outputPosition, this.outputPosition + pieceLength);
      this.outputPosition += pieceLength;
      const opus = this.encoder.encode(frame);

      // Send audio data to the device
      if (this.protocolVersion === 2) {
        // format: [version, reserved, timestamp, opus_length, opus_data]
        const buffer = Buffer.alloc(16 + opus.length);
        buffer.writeUInt32BE(this.audioTimestamp, 8);
        buffer.writeUInt32BE(opus.length, 12);
        buffer.set(opus, 16);
        this.audioTimestamp += this.encodeFrameSize;
        this.ws.send(buffer, { binary: true });
      } else if (this.protocolVersion === 3) {
        // format: [type, flag, length, opus_data] 省流模式，只需要 4 字节的 header
        const buffer = Buffer.alloc(4 + opus.length);
        buffer.writeUInt16BE(opus.length, 2);
        buffer.set(opus, 4);
        this.ws.send(buffer, { binary: true });
      }
    }
  }

  async setupTtsSession() {
    const session = this.client.newSession(this.voice, this.sampleRate);
    session.on('sentence_start', (text) => {
      console.log('[TTS]', text);
      this.ws.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text }));
    });
    session.on('sentence_end', (text) => {
      this.ws.send(JSON.stringify({ type: 'tts', state: 'sentence_end', text }));
    });
    session.on('audio', (pcm) => {
      if (this.source === 'dashscope') {
        const fs = require('fs');
        // append to tts.pcm
        fs.appendFileSync('tts.pcm', pcm);
      }
      this.encodeAudio(pcm);
    });
    session.on('finished', () => {
      this.ws.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      console.log('[TTS] finished voice_id', this.voice, 'sample_rate', this.sampleRate);
      this.session = null;
    });

    if (this.replyText.length > 0) {
      console.log('[TTS] setup with text:', this.replyText);
      session.write(this.replyText);
      if (this.finished) {
        session.finish();
        return;
      }
    }
    this.session = session;
  }

  removeCurrentSession() {
    if (this.session) {
      if (!this.finished) {
        if (this.session.cancel) {
          this.session.cancel();
        } else {
          this.session.finish();
        }
      }
      this.session = null;
    }
  }

  handleMessage(message) {
    const data = JSON.parse(message);
    if (data.type === 'start') {
      this.replyText = '';
      this.finished = false;
      this.ws.send(JSON.stringify({
        type: 'tts',
        state: 'start',
        sample_rate: this.sampleRate,
      }));

      this.removeCurrentSession();
      if (this.client && this.client.connectionReady) {
        this.setupTtsSession();
      } else {
        this.queueEvents.push({
          resolve: () => this.setupTtsSession(),
        });
      }
    } else if (data.type === 'text') {
      this.replyText += data.text;
      if (this.session) {
        this.session.write(data.text);
      }
    } else if (data.type === 'finish') {
      this.finished = true;
      if (this.session) {
        this.session.finish();
      }
    } else if (data.type === 'config') {
      const ttsItem = ttsList.find(item => item.voice_id === data.voice);
      if (!ttsItem) {
        console.error(`无效的语音: ${data.voice}`);
        this.ws.send(JSON.stringify({
          type: 'tts',
          state: 'error',
          error: `无效的语音: ${data.voice}`,
        }));
        this.ws.close();
        return;
      }

      this.ttsItem = ttsItem;
      this.protocolVersion = data.protocolVersion || 2;
      this.sampleRate = data.sampleRate || config.encodeSampleRate;
      this.reset();
      this.voice = data.voice;
      this.startClient();
    } else if (data.type === 'abort') {
      if (this.session) {
        this.removeCurrentSession();
        if (this.client) {
          this.client.close();
        }
        this.ws.send(JSON.stringify({ type: 'tts', state: 'stop' }));
        console.log('[TTS] aborted, starting new client');
        this.startClient();
      }
    }
  }

  startClient() {
    this.client = new ttsClients[this.ttsItem.voice_source]();
    this.client.on('ready', () => {
      while (this.queueEvents.length > 0) {
        const event = this.queueEvents.shift();
        event.resolve();
      }
    });
    this.client.on('error', (error) => {
      console.error('[TTS] client error', error);
    });
    this.client.on('close', () => {
      console.log('[TTS] client closed');
    });
    this.client.on('error', () => {
      this.ttsErrorCount++;
      if (this.ttsErrorCount > 3) {
        this.ws.close();
        return;
      }
      // 如果 TTS session 出错，重新创建 TTS 会话，并重新发送文本
      if (this.client && this.client.connectionReady && this.session) {
        console.log('[TTS] client error, retrying');
        this.queueEvents.push({
          resolve: () => this.setupTtsSession(),
        });
        this.startClient();
      }
    });
  }

  handleClose() {
    this.removeCurrentSession();
    if (this.client) {
      this.client.close();
    }
  }
}

const wss = new WebSocket.Server({ port: config.ttsFrontendPort });

wss.on('connection', (ws) => {
  const handler = new TtsSessionHandler(ws);

  ws.on('message', (message) => handler.handleMessage(message));
  ws.on('close', () => handler.handleClose());
});

wss.on('listening', () => {
  console.log(`TTS 前端服务已启动，监听端口 ${config.ttsFrontendPort}`);
});
