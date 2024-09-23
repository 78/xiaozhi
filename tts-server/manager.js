const { EventEmitter } = require('events');
const { TtsClient } = require('./bytedance_tts');

class TtsClientManager extends EventEmitter {
  constructor(maxClients = 3) {
    super();
    this.clients = [];
    this.maxClients = maxClients;
  }

  createClient() {
    return new Promise((resolve, reject) => {
      const client = new TtsClient();
      const timeoutId = setTimeout(() => {
        reject(new Error('客户端连接超时'));
        this.destroyClient(client);
      }, 10000); // 10秒超时

      client.once('ready', () => {
        clearTimeout(timeoutId);
        this.onClientReady(client);
        resolve(client);
      });

      client.on('error', (err) => this.onClientError(client, err));
      client.on('close', () => this.onClientClose(client));

      this.clients.push(client);
    });
  }

  onClientReady(client) {
    console.log(`TTS客户端 ${client.reqId} 连接就绪。`);
    this.emit('ready', client);
  }

  onClientError(client, err) {
    console.error(new Date(), `TTS客户端 ${client.reqId} 错误:`, err);
  }

  onClientClose(client) {
    console.log(`TTS客户端 ${client.reqId} 连接已关闭。将在下次需要时重新创建。`);
    this.destroyClient(client);
  }

  destroyClient(client) {
    const index = this.clients.indexOf(client);
    if (index !== -1) {
      client.removeAllListeners();
      client.socket.close();
      this.clients.splice(index, 1);
    }
  }

  async getClient() {
    // 获取所有就绪的客户端
    const readyClients = this.clients.filter(client => client.socket && client.socket.readyState === 1 && client.connectionReady);
    
    if (readyClients.length > 0) {
      // 随机选择一个就绪的客户端
      return readyClients[Math.floor(Math.random() * readyClients.length)];
    }

    // 如果没有就绪的客户端，并且还没有达到最大客户端数量，则创建一个新的
    if (this.clients.length < this.maxClients) {
      try {
        return await this.createClient();
      } catch (error) {
        console.error('创建新客户端失败:', error);
        throw error;
      }
    }

    // 如果已达到最大客户端数量，则抛出错误
    throw new Error('没有可用的TTS客户端，且已达到最大客户端数量');
  }

  destroy() {
    this.clients.forEach(client => {
      client.removeAllListeners();
      client.close();
    });
    this.clients = [];
  }
}

module.exports = TtsClientManager;
