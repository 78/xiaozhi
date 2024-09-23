const WebSocket = require('ws');
const config = require('./config');
const { OpusEncoder } = require('@discordjs/opus');
const TtsClientManager = require('./manager');
const ttsClientManager = new TtsClientManager();

const wss = new WebSocket.Server({ port: config.ttsFrontendPort });

wss.on('connection', (ws) => {
  const encodeFrameSize = config.encodeSampleRate / 1000 * config.encodeIntervalMs;
  const encoder = new OpusEncoder(config.encodeSampleRate, 1);
  encoder.applyEncoderCTL(4000, 2048); // VOIP
  
  let outputBuffer = Buffer.alloc(0);
  let outputPosition = 0;
  let audioTimestamp = 0;
  let session = null;
  let ttsErrorCount = 0;
  let replyText = '';
  let finished = false;
  let voice = null;

  function encodeAudio(pcm) {
    outputBuffer = Buffer.concat([outputBuffer, pcm]);
    const pieceLength = encodeFrameSize * 2;
    
    while (outputBuffer.length - outputPosition >= pieceLength) {
      const frame = outputBuffer.subarray(outputPosition, outputPosition + pieceLength);
      outputPosition += pieceLength;
      const opus = encoder.encode(frame);

      // Send audio data to the device
      // format: [version, reserved, timestamp, opus_length, opus_data]
      const buffer = Buffer.alloc(16 + opus.length);
      buffer.writeUInt32BE(audioTimestamp, 8);
      buffer.writeUInt32BE(opus.length, 12);
      buffer.set(opus, 16);
      audioTimestamp += encodeFrameSize / 2;
      ws.send(buffer, { binary: true });
    }
  }

  // When the TTS session starts, events are emitted in the following order:
  // - started
  // - sentence_start
  // - audio
  // - sentence_end
  // - finished
  async function setupTtsSession() {
    const client = await ttsClientManager.getClient();
    session = client.newSession(voice);
    session.on('sentence_start', (text) => {
      console.log('[TTS]', text);
      ws.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text }));
    });
    session.on('sentence_end', (text) => {
      ws.send(JSON.stringify({ type: 'tts', state: 'sentence_end', text }));
    });
    session.on('audio', (pcm) => {
      encodeAudio(pcm);
    });
    session.on('finished', () => {
      ws.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      ws.close();
    });
    session.on('cancelled', async () => {
      // 如果 TTS 会话被取消，重新创建 TTS 会话，并重新发送文本
      ttsErrorCount++;
      if (ttsErrorCount > 3) {
        ws.close();
        return;
      }
      await setupTtsSession(ws);
    });
    
    if (replyText.length > 0) {
      console.log('[TTS] setup with text:', replyText);
      session.write(replyText);
      if (finished) {
        session.finish();
      }
    }
  }

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.type === 'text') {
      replyText += data.text;
      if (session) {
        session.write(data.text);
      }
    } else if (data.type === 'start') {
      voice = data.voice;
      setupTtsSession();
      ws.send(JSON.stringify({
        type: 'tts',
        state: 'start',
        sample_rate: config.encodeSampleRate,
      }));
    } else if (data.type === 'finish') {
      finished = true;
      if (session) {
        session.finish();
      }
    }
  });

  ws.on('close', () => {
    if (session && !finished) {
      session.finish();
    }
  });
});


wss.on('listening', () => {
  console.log(`TTS 前端服务已启动，监听端口 ${config.ttsFrontendPort}`);
});
