module.exports = {
  asrFrontendPort: process.env.NODE_ENV=='dev' ? 8182 : 8082,    // 用于处理前端识别连接请求
  asrBackendPort: process.env.NODE_ENV=='dev' ? 8181 : 8081,        // 用于与后端推理服务器通信
  asrBackendPingInterval: 30000, // 30s
  decodeSampleRate: 16000,
};