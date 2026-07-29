'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 「当前会话」指针存储（类似 shell 的 cwd）：按 conversationKey 记住信使正在与哪个 worker 会话沟通。
 * 用户「切到 abc」后，后续「继续…」等普通指令即默认转发到该会话。
 */
class FileCurrentStore {
  constructor(file) {
    this.file = file;
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
    return this._read()[key] || null;
  }

  set(key, sessionId) {
    const o = this._read();
    o[key] = sessionId;
    this._write(o);
  }

  clear(key) {
    const o = this._read();
    delete o[key];
    this._write(o);
  }
}

module.exports = { FileCurrentStore };
