'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 信使会话历史的文件存储（按 conversationKey 存 AI SDK ModelMessage 数组）。
 * Web 与 IM 用同一 key => 共享上下文。
 */
class FileHistoryStore {
  constructor(file, maxMessages = 200) {
    this.file = file;
    this.maxMessages = maxMessages;
  }

  _read() {
    if (!fs.existsSync(this.file)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  _write(obj) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }

  get(key) {
    return this._read()[key] || [];
  }

  set(key, messages) {
    const o = this._read();
    // 截断到最近 N 条，避免无限增长
    o[key] = messages.length > this.maxMessages
      ? messages.slice(-this.maxMessages) : messages;
    this._write(o);
  }

  clear(key) {
    const o = this._read();
    delete o[key];
    this._write(o);
  }
}

module.exports = { FileHistoryStore };
