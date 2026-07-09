#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const pkg = require('../package.json');

const init = require('../src/commands/init');
const configGet = require('../src/commands/get');
const configSet = require('../src/commands/set');
const configRemove = require('../src/commands/remove');
const configList = require('../src/commands/list');
const projectAdd = require('../src/commands/project-add');
const projectRemove = require('../src/commands/project-remove');
const projectList = require('../src/commands/project-list');
const start = require('../src/commands/start');

program
  .name('cc-router')
  .description('cc-connect-router 配置管理工具')
  .version(pkg.version);

// init
program
  .command('init')
  .description('初始化配置目录与默认配置文件')
  .option('-f, --force', '覆盖已存在的配置文件')
  .action(init);

// config 子命令组
const config = program
  .command('config')
  .description('读写配置项');

config
  .command('get <key>')
  .description('获取配置项的值（支持点号路径）')
  .action(configGet);

config
  .command('set <key> <value>')
  .description('设置配置项的值（自动类型推断）')
  .action(configSet);

config
  .command('remove <key>')
  .description('删除配置项')
  .option('-y, --yes', '跳过确认')
  .action(configRemove);

config
  .command('list')
  .description('列出完整配置（敏感字段遮掩）')
  .action(configList);

// project 子命令组
const project = program
  .command('project')
  .description('管理项目配置');

project
  .command('add <name> <work_dir>')
  .description('添加新项目')
  .option('--agent <type>', 'agent 类型 (opencode|qoder)', 'opencode')
  .option('--platform <type>', 'platform 类型 (dingtalk)', 'dingtalk')
  .action(projectAdd);

project
  .command('remove <name>')
  .description('删除项目')
  .option('-y, --yes', '跳过确认')
  .action(projectRemove);

project
  .command('list')
  .description('列出所有项目')
  .action(projectList);

// start
program
  .command('start')
  .description('使用当前配置启动 cc-connect')
  .action(start);

program.parse(process.argv);
