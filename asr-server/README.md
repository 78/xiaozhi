# ASR Server

## 简介

ASR Server 分为两部分：

1. 前端服务器：负责接收来自前端的音频数据。

2. 后端服务器：负责管理后端的推理节点，并将音频数据发送给推理节点。

## 安装

```javascript
npm install
node app.js
```

## 前端 WebSocket 协议

### 发起请求

JSON：

计算唤醒词的 embedding。

```json
{
  "type": "detect",
  "words": "小智"
}
```

二进制：

发送音频 PCM 数据。


### 响应

JSON：

```json
{
  "type": "text",
  "text": "你好，小智",
  "embedding": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  "url": "http://example.com/audio.ogg"
}
```
