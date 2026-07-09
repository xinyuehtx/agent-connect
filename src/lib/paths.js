'use strict';

const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CC_ROUTER_CONFIG_DIR
  || path.join(os.homedir(), '.cc-connect-router');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.toml');
const CONFIG_BACKUP_DIR = path.join(CONFIG_DIR, 'backups');

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  CONFIG_BACKUP_DIR,
};
