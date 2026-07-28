'use strict';

/**
 * 极简 SSE 广播中枢。
 */
class SseHub {
  constructor() {
    this.clients = new Set();
  }

  add(sink) {
    this.clients.add(sink);
  }

  remove(sink) {
    this.clients.delete(sink);
  }

  send(sink, event, data) {
    try {
      sink.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      this.clients.delete(sink);
    }
  }

  broadcast(event, data) {
    for (const c of this.clients) {
      this.send(c, event, data);
    }
  }

  count() {
    return this.clients.size;
  }
}

module.exports = { SseHub };
