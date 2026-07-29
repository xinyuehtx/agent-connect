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
const serve = require('../src/commands/serve');
const acp = require('../src/commands/acp');
const agentList = require('../src/commands/agent-list');
const agentRead = require('../src/commands/agent-read');
const agentSend = require('../src/commands/agent-send');
const agentTakeover = require('../src/commands/agent-takeover');
const agentRun = require('../src/commands/agent-run');

program
  .name('agent-connect')
  .description('agent-connect 配置管理工具')
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

// serve：启动 Web 控制台 + 信使栈 + IM 闸门（长跑守护）
program
  .command('serve')
  .description('启动 Web 控制台与信使 Agent 守护（读写平面 + 安全闸）')
  .option('-H, --host <host>', 'Web 监听地址')
  .option('-p, --port <port>', 'Web 监听端口')
  .action(serve);

// acp：作为 cc-connect 的 acp agent（由 cc-connect exec，勿手动运行）
program
  .command('acp')
  .description('ACP 薄桥：供 cc-connect 作为 acp agent 拉起，转发消息给 serve 守护')
  .action(acp);

// agent 子命令组：发现与控制本机运行中的 Agent 会话
const agent = program
  .command('agent')
  .description('发现与控制本机运行中的 Agent 会话');

agent
  .command('list')
  .description('列出运行中的 Agent 会话')
  .option('-a, --all', '包含已退出/仅存磁盘记录的会话')
  .option('--json', '以 JSON 输出')
  .action(agentList);

agent
  .command('read <sessionId>')
  .description('查看会话状态与最新回复（只读，不污染上下文）')
  .option('--json', '以 JSON 输出')
  .option('--full', '完整输出，不截断')
  .action(agentRead);

agent
  .command('send <sessionId> <text>')
  .description('向 tmux 托管的会话注入指令（含空格请用引号包裹）')
  .option('--no-enter', '注入后不自动回车')
  .action(agentSend);

agent
  .command('takeover <sessionId>')
  .description('接管非 tmux 会话（kill 原进程 + resume 进 tmux）')
  .option('--force', '忽略 busy 保护，强制接管')
  .option('--mode <mode>', '权限模式（默认按 agent 类型）')
  .action(agentTakeover);

agent
  .command('run [prompt]')
  .description('在 tmux 中启动一个可远控的新会话')
  .option('-w, --cwd <dir>', '工作目录（默认当前目录）')
  .option('--tool <tool>', 'agent 类型 (claude|qoder)', 'claude')
  .option('--mode <mode>', '权限模式（默认按 agent 类型）')
  .action(agentRun);

program.parse(process.argv);
