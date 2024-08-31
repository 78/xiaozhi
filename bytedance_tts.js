// terrence@tenclass.com
// 2024-08-27
// 大模型语音合成双向流式API
// (https://www.volcengine.com/docs/6561/1329505)

require('dotenv').config();
const { WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Emitter = require('events');


class TtsSession extends Emitter {
  constructor(client, speaker) {
    super();
    this.client = client;
    this.sessionId = uuidv4();
    this.params = {
      speaker,
      audio_params: {
        format: 'pcm',
        sample_rate: 16000
      }
    };
  }

  start() {
    const payload = {
      namespace: 'BidirectionalTTS',
      event: 100,
      req_params: {
        ...this.params
      }
    };
    this.client.sendFullClientRequest(payload.event, payload, this.sessionId);
  }

  write(text) {
    const payload = {
      namespace: 'BidirectionalTTS',
      event: 200,
      req_params: {
        ...this.params,
      }
    };
    payload.req_params.text = text;
    this.client.sendFullClientRequest(payload.event, payload, this.sessionId);
  }

  finish() {
    const payload = {};
    this.client.sendFullClientRequest(102, payload, this.sessionId);
  }
}

class TtsClient extends Emitter {
  constructor() {
    super();
    this.sessions = {};
    this.reqId = uuidv4();
    this.socket = new WebSocket('wss://openspeech.bytedance.com/api/v3/tts/bidirection', {
      headers: {
        'X-Api-App-Key': process.env.BYTEDANCE_TTS_APP_ID,
        'X-Api-Access-Key': process.env.BYTEDANCE_TTS_ACCESS_TOKEN,
        'X-Api-Resource-Id': 'volc.service_type.10029',
        'X-Api-Request-Id': this.reqId
      }
    });

    this.socket.on('open', () => {
      this.sendFullClientRequest(1, {});
    });

    this.socket.on('message', (data) => {
      this.handleServerResponse(data);
    });

    this.socket.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      console.log('WebSocket closed.');
      this.emit('close');
    });
  }

  newSession(speaker) {
    const session = new TtsSession(this, speaker || 'zh_female_shuangkuaisisi_moon_bigtts');
    this.sessions[session.sessionId] = session;
    session.start();
    return session;
  }

  handleServerResponse(data) {
    // Get the second byte: message type
    const messageType = data.readUInt8(1);
    if (messageType == 0xF0) {
      this.parseErrorResponse(data);
    } else if (messageType == 0x94) {
      this.parseFullServerResponse(data);
    } else if (messageType == 0xB4) {
      this.parseAudioResponse(data);
    } else {
      console.error('Unknown message type:', messageType);
    }
  }

  parseErrorResponse(data) {
    const errorCode = data.readUInt32BE(4);
    const errorMessageLength = data.readUInt32BE(8);
    const errorMessage = data.toString('utf8', 12, 12 + errorMessageLength);
    console.error(`Error code: ${errorCode}, message: ${errorMessage}`);
  }

  sendFullClientRequest(eventCode, payload, sessionId) {
    const header = Buffer.from('11141000', 'hex');
    const optional = Buffer.alloc(4);
    optional.writeUInt32BE(eventCode);
    const payloadBuffer = Buffer.from(JSON.stringify(payload));
    const payloadLengthBuffer = Buffer.alloc(4);
    payloadLengthBuffer.writeUInt32BE(payloadBuffer.length);

    if (sessionId) {
      const sessionIdBuffer = Buffer.alloc(4 + sessionId.length);
      sessionIdBuffer.writeUInt32BE(sessionId.length);
      sessionIdBuffer.write(sessionId, 4);
      const fullRequest = Buffer.concat([header, optional,
        sessionIdBuffer, payloadLengthBuffer, payloadBuffer]);
      this.socket.send(fullRequest);
    } else {
      const fullRequest = Buffer.concat([header, optional, payloadLengthBuffer, payloadBuffer]);
      this.socket.send(fullRequest);
    }
  }

  parseFullServerResponse(data) {
    const eventCode = data.readUInt32BE(4);
    if (eventCode == 50) {
      this.connectionReady = true;
      // PING every 30 seconds
      this.pingTimer = setInterval(() => {
        this.socket.ping();
      }, 30000);

      this.emit('ready');
    } else if (eventCode == 51) {
      this.connectionReady = false;
      clearInterval(this.pingTimer);
      console.error('Failed to connect to TTS server.');
    } else if (eventCode == 52) {
      console.log('Connection closed by server.');
      this.socket.close();
    } else {
      let offset = 8;
      const sessionIdLength = data.readUInt32BE(offset);
      offset += 4;
      const sessionId = data.toString('utf8', offset, offset + sessionIdLength);
      offset += sessionIdLength;
      const payloadLength = data.readUInt32BE(offset);
      offset += 4;
      const payload = JSON.parse(data.toString('utf8', offset, offset + payloadLength));
      const session = this.sessions[sessionId];
      if (!session) {
        console.error('parseFullServerResponse: Session not found:', sessionId);
        return;
      }
      
      switch (eventCode) {
      case 150:
        session.emit('started');
        break;
      case 151:
        session.emit('cancelled');
        delete this.sessions[sessionId];
        break;
      case 152:
        session.emit('finished');
        delete this.sessions[sessionId];
        break;
      case 153:
        session.emit('error', payload);
        break;
      case 350:
        session.emit('sentence_start', payload.text);
        break;
      case 351:
        session.emit('sentence_end', payload.text);
        break;
      default:
        console.error('Unknown event code:', eventCode);
      }
    }
  }

  parseAudioResponse(data) {
    let offset = 8;
    const sessionIdLength = data.readUInt32BE(offset);
    offset += 4;
    const sessionId = data.toString('utf8', offset, offset + sessionIdLength);
    offset += sessionIdLength;
    const audioLength = data.readUInt32BE(offset);
    offset += 4;
    const audio = data.slice(offset, offset + audioLength);
    
    const session = this.sessions[sessionId];
    if (!session) {
      console.error('parseAudioResponse: Session not found:', sessionId);
      return;
    }
    session.emit('audio', audio);
  }

  finishConnection() {
    this.sendFullClientRequest(2, {});
  }
};


function test() {
  const tts = new TtsClient();
  tts.on('ready', () => {
    console.log('TTS server is ready.');

    const session = tts.newSession();
    session.on('started', async () => {
      console.log('TTS session started.');

      session.write('你好，主人！');
      session.finish();
    });

    let t = Buffer.alloc(0);
    session.on('audio', (audio) => {
      t = Buffer.concat([t, audio]);
    });

    session.on('finished', () => {
      console.log('TTS session finished.');
      tts.finishConnection();

      const fs = require('fs');
      fs.writeFileSync('tts.pcm', t);
      console.log('Audio data written to tts.pcm, size:', t.length);
      console.log('To play the audio, run: ffplay -f s16le -ar 24000 -ac 1 tts.pcm');
    });
  });
}

if (require.main === module) {
  test();
} else {
  module.exports = { TtsClient };
}
