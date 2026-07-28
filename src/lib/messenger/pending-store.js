'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 待确认动作的文件存储（按 conversationKey 分桶）。
 * 移植自 lifestream FilePendingStore。
 */
class FilePendingStore {
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
    return this._read()[key] || [];
  }

  set(key, actions) {
    const o = this._read();
    o[key] = actions;
    this._write(o);
  }

  clear(key) {
    const o = this._read();
    delete o[key];
    this._write(o);
  }
}

module.exports = { FilePendingStore };
