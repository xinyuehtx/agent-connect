'use strict';

const { loadConfig, saveConfig, ensureConfigDir } = require('./lib/config-store');
const paths = require('./lib/paths');

module.exports = {
  loadConfig,
  saveConfig,
  ensureConfigDir,
  paths,
};
