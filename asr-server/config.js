module.exports = {
  asrFrontendPort: 8082,       // 用于处理前端识别连接请求
  asrBackendPort: 8081,        // 用于与后端推理服务器通信
  asrBackendPingInterval: 30000, // 30s
  decodeSampleRate: 16000,
};
