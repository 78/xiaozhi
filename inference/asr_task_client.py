'''
Audio Recognition Task Client
这个服务用于接收语音识别任务，并将识别结果发送给调用方。
可以运行于没有公网 IP 的环境，通过 WebSocket 连接到任务分发服务器。

terrence@tenclass.com
2024-09
'''

import logging
import sys
# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s', stream=sys.stdout)
# 加载环境变量
from dotenv import load_dotenv
load_dotenv()

import os
import numpy as np
import time
import json
import websocket
import uuid
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess
from modelscope.models.base import Model
from audio_storage import AudioStorage


# 常量定义
ASR_TASK_SERVER_URL = os.getenv("ASR_TASK_SERVER_URL")
SAMPLE_RATE = 16000


class ModelManager:
    def __init__(self):
        self.vad_model = None
        self.sense_model = None
        self.sv_model = None

    def load_models(self):
        self.vad_model = AutoModel(
            model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            model_revision="v2.0.4",
            max_end_silence_time=240,
            speech_noise_thres=0.8,
            disable_update=True,
            disable_pbar=True,
            device="cuda",
        )

        self.sense_model = AutoModel(
            model="iic/SenseVoiceSmall",
            device="cuda",
            disable_update=True,
            disable_pbar=True,
        )

        self.sv_model = Model.from_pretrained("iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common", device="cuda")


class AsrWorker:
    def __init__(self, wsapp, session_id, model_manager, audio_storage):
        self.wsapp = wsapp
        self.session_id = session_id
        self.model_manager = model_manager
        self.audio_storage = audio_storage
        self.chunk_size_ms = 240  # VAD duration
        self.chunk_size = int(SAMPLE_RATE / 1000 * 2 * self.chunk_size_ms)
        self.fast_reply_silence_duration = 0  # Fast reply duration
        self.reply_silence_duration = 720  # Reply duration
        self.truncate_silence_duration = 1440  # Truncate duration
        self.started = False
        self.reset()

    def reset(self):
        self.audio_buffer = np.array([], dtype=np.float32)
        self.audio_process_last_pos_ms = 0
        self.vad_cache = {}
        self.vad_last_pos_ms = -1
        self.vad_cached_segments = []
        self.vad_updated = False
        self.content = ''

    def truncate(self):
        if self.audio_process_last_pos_ms < self.truncate_silence_duration:
            return
        self.audio_buffer = self.audio_buffer[-self.chunk_size_ms * 16:] # Keep the last chunk
        self.audio_process_last_pos_ms = 0 # The last chunk will be processed again
        self.vad_cache = {}

    def get_unprocessed_duration(self):
        return self.audio_buffer.shape[0] / 16 - self.audio_process_last_pos_ms

    def get_silence_duration(self):
        if self.vad_last_pos_ms == -1:
            return 0
        return self.audio_buffer.shape[0] / 16 - self.vad_last_pos_ms

    def is_question(self):
        # TODO: Use a model to detect questions
        match_tokens = ['吗', '嘛', '么', '呢', '吧', '？', '?']
        return any([token in self.content for token in match_tokens])

    def on_audio_frame(self, frame):
        frame_fp32 = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768
        self.audio_buffer = np.concatenate([self.audio_buffer, frame_fp32])

        if not self.started:
            return

        if self.get_unprocessed_duration() < self.chunk_size_ms:
            return
        self.generate_vad_segments()

        if len(self.vad_cached_segments) == 0:
            self.truncate()
            return

        if self.vad_last_pos_ms == -1: # Speech still going on
            return
        
        if self.vad_updated:
            self.vad_updated = False
            start_time = time.time()
            self.content = self.generate_text()
            logging.info(f'[VAD UPDATE] {self.content} (time: {time.time() - start_time:.2f}s)')
            return
        
        if self.is_question() and self.get_silence_duration() >= self.fast_reply_silence_duration:
            logging.info('Fast reply detected')
            self.reply()
            return
        if self.get_silence_duration() >= self.reply_silence_duration:
            logging.info('Silence detected')
            self.reply()
            return

    def generate_vad_segments(self):
        beg = self.audio_process_last_pos_ms * 16
        end = beg + self.chunk_size
        chunk = self.audio_buffer[beg:end]
        self.audio_process_last_pos_ms += self.chunk_size_ms

        result = self.model_manager.vad_model.generate(input=chunk, cache=self.vad_cache, chunk_size=self.chunk_size_ms)
        if len(result[0]['value']) > 0:
            self.vad_cached_segments.extend(result[0]['value'])
            self.vad_last_pos_ms = self.vad_cached_segments[-1][1]
            if self.vad_last_pos_ms != -1:
                self.vad_updated = True

    def generate_text(self):
        result = self.model_manager.sense_model.generate(input=self.audio_buffer, cache={}, language='zh', use_itn=True)
        return rich_transcription_postprocess(result[0]['text'])

    def generate_embedding(self):
        result = self.model_manager.sv_model(self.audio_buffer)
        return result.tolist()

    def reply(self):
        if self.content == '。':
            logging.info(f'Ignore empty content {self.content}')
            self.reset()
            return
        
        oss_prefix = os.getenv('OSS_BUCKET_URL', '')
        oss_key = f'asr/{uuid.uuid4()}.ogg'
        message = {
            'type': 'chat',
            'session_id': self.session_id,
            'content': self.content,
            'embedding': self.generate_embedding(),
            'url': os.path.join(oss_prefix, oss_key)
        }
        logging.info(f'[REPLY] {self.content}')
        self.wsapp.send(json.dumps(message).encode())
        self.audio_storage.async_put(oss_key, self.content, self.audio_buffer)
        self.reset()
    
    def detect(self, words):
        self.content = words # Directly use the words, ignore the audio buffer
        self.reply()
        self.started = True


class AsrTaskClient:
    def __init__(self):
        self.model_manager = ModelManager()
        self.audio_storage = AudioStorage(SAMPLE_RATE)
        self.workers = {}
        self.wsapp = None

    def initialize(self):
        self.model_manager.load_models()
        self.audio_storage.start()

    def get_worker(self, session_id):
        if session_id not in self.workers:
            self.workers[session_id] = AsrWorker(self.wsapp, session_id, self.model_manager, self.audio_storage)
        return self.workers[session_id]

    def parse_binary_message(self, message):
        # session_id len 4u be, session_id, pcm len 4u be, pcm
        session_id_len = int.from_bytes(message[:4], 'big')
        session_id = message[4:4 + session_id_len].decode()
        pcm_len = int.from_bytes(message[4 + session_id_len:8 + session_id_len], 'big')
        pcm = message[8 + session_id_len:8 + session_id_len + pcm_len]

        worker = self.get_worker(session_id)
        if worker is not None:
            worker.on_audio_frame(pcm)

    def parse_text_message(self, message):
        data = json.loads(message)
        session_id = data['session_id']

        if data['type'] == 'detect':
            self.get_worker(session_id).detect(data['words'])
        elif data['type'] == 'finish':
            del self.workers[session_id]
            logging.info(f'Worker {session_id} finished')
        else:
            logging.warning(f'Unknown message type: {data["type"]}')

    def on_message(self, wsapp, message):
        if isinstance(message, bytes):
            self.parse_binary_message(message)
        else:
            self.parse_text_message(message)

    def on_open(self, wsapp):
        logging.info('Connected to the Asr Task Server.')

    def run(self):
        logging.info('Starting Asr Task Client...')
        self.wsapp = websocket.WebSocketApp(
            ASR_TASK_SERVER_URL,
            on_message=self.on_message,
            on_open=self.on_open
        )

        while True:
            try:
                ret = self.wsapp.run_forever()
                if ret is None:
                    break
            except Exception as e:
                logging.error(f"An error occurred: {e}", exc_info=True)
            # Remove all workers
            self.workers = {}
            logging.info('Reconnecting to the Asr Task Server in 3 seconds...')
            time.sleep(3)


if __name__ == "__main__":
    task_client = AsrTaskClient()
    task_client.initialize()
    task_client.run()

