# ASR Task Client

这个服务用于接收语音识别任务，并将识别结果发送给调用方。

可以运行于没有公网 IP 的环境，通过 WebSocket 连接到任务分发服务器，以便于快速扩容。


### 使用到以下开源模型：

VAD：<a href="https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch">speech_fsmn_vad_zh-cn-16k-common-pytorch</a>

ASR：<a href="https://modelscope.cn/models/iic/SenseVoiceSmall">SenseVoiceSmall</a>

Embedding：<a href="https://modelscope.cn/models/iic/speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common">ERes2NetV2_w24s4ep4</a>

### 效率：

VAD < 1ms，ASR < 50ms，Embedding < 50ms 


## 硬件要求

GPU 显存：4GB

使用 CPU 增加 5 ~ 10 倍的请求耗时。

## 运行环境

需要配置环境变量

ASR_TASK_SERVER_URL=wss://



```bash
conda create -n xiaozhi python=3.12
codna activate xiaozhi

pip install -r requirements.txt
python asr_task_client.py
```

## WebSocket 协议

### 发起请求

JSON：

1、detect 开始检测任务

```json
{ "session_id": "xxx", "type": "detect", "words": "小智" }
```

2、finish 完成检测任务

```json
{ "session_id": "xxx", "type": "finish" }
```

二进制：

每次发送的二进制数据包含 session_id 和 PCM 音频数据两部分，格式如下：

```
session_id length，uint32 big
session_id 字符串
pcm length，uint32 big
pcm data
```

### 接收结果

JSON：

```json
{ "session_id": "xxx", "type": "reply", "content": "文本内容", "embedding": "音频向量", "url": "音频下载地址" }
```

