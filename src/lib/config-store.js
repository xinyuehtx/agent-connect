'use strict';

const fs = require('fs');
const path = require('path');
const TOML = require('@iarna/toml');
const { CONFIG_DIR, CONFIG_FILE, CONFIG_BACKUP_DIR } = require('./paths');

/**
 * 确保配置目录存在（含备份目录）。
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_BACKUP_DIR)) {
    fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
  }
}

/**
 * 读取并解析 TOML 配置文件。
 * 若文件不存在则返回空对象。
 * @returns {object}
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = fs.readFileSync(CONFIG_FILE, 'utf8');
  return TOML.parse(content);
}

/**
 * 备份当前配置文件到备份目录。
 * @returns {string|null} 备份文件路径，若无原文件则返回 null
 */
function backupConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  ensureConfigDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(CONFIG_BACKUP_DIR, `config.${timestamp}.toml`);
  fs.copyFileSync(CONFIG_FILE, backupFile);
  return backupFile;
}

/**
 * 序列化并写入 TOML 配置文件（写入前自动备份）。
 * @param {object} data
 */
function saveConfig(data) {
  ensureConfigDir();
  backupConfig();
  const content = TOML.stringify(data);
  fs.writeFileSync(CONFIG_FILE, content, 'utf8');
}

/**
 * 通过点号路径获取嵌套值。
 * @param {object} obj
 * @param {string} keyPath 例如 "projects.agent.type"
 * @returns {*} 若路径不存在返回 undefined
 */
function getNestedValue(obj, keyPath) {
  if (!keyPath) {
    return undefined;
  }
  const keys = keyPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * 通过点号路径设置嵌套值（自动创建中间对象）。
 * @param {object} obj
 * @param {string} keyPath
 * @param {*} value
 * @returns {object} 修改后的对象
 */
function setNestedValue(obj, keyPath, value) {
  const keys = keyPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * 通过点号路径删除值。
 * @param {object} obj
 * @param {string} keyPath
 * @returns {boolean} 是否成功删除
 */
function deleteNestedValue(obj, keyPath) {
  const keys = keyPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      return false;
    }
    current = current[key];
  }
  const lastKey = keys[keys.length - 1];
  if (Object.prototype.hasOwnProperty.call(current, lastKey)) {
    delete current[lastKey];
    return true;
  }
  return false;
}

module.exports = {
  ensureConfigDir,
  loadConfig,
  backupConfig,
  saveConfig,
  getNestedValue,
  setNestedValue,
  deleteNestedValue,
};
