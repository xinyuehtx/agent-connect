'use strict';

const { spawnSync } = require('child_process');

let _installed;

/**
 * 统一的 tmux 调用封装。
 * @param {string[]} args
 * @param {object} [opts] spawnSync 选项（如 { input }）
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function tmux(args, opts = {}) {
  return spawnSync('tmux', args, { encoding: 'utf8', ...opts });
}

/**
 * tmux 是否已安装（结果缓存）。
 * @returns {boolean}
 */
function isInstalled() {
  if (_installed === undefined) {
    _installed = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
  }
  return _installed;
}

/**
 * 目标 tmux 会话是否存在。
 * @param {string} name
 * @returns {boolean}
 */
function hasSession(name) {
  return tmux(['has-session', '-t', name]).status === 0;
}

/**
 * 归一化 tty 表示，便于跨来源比较：
 *   "/dev/ttys005" → "s005"，"s005" → "s005"
 * @param {string} t
 * @returns {string}
 */
function normalizeTty(t) {
  return (t || '').replace(/^\/dev\/(tty)?/, '');
}

/**
 * 列出所有 tmux pane 及其 tty / target。
 * @returns {Array<{tty:string, target:string, session:string}>}
 */
function listPanes() {
  const r = tmux([
    'list-panes', '-a', '-F',
    '#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}\t#{session_name}',
  ]);
  if (r.status !== 0) {
    return [];
  }
  return (r.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tty, target, session] = line.split('\t');
      return { tty, target, session };
    });
}

/**
 * 根据进程 tty 反查其所在的 tmux pane target（用于识别"外部 tmux"会话）。
 * @param {string} tty 形如 "s005"
 * @returns {string|null}
 */
function findTargetByTty(tty) {
  if (!tty) {
    return null;
  }
  const target = normalizeTty(tty);
  const hit = listPanes().find((p) => normalizeTty(p.tty) === target);
  return hit ? hit.target : null;
}

/**
 * 在后台（detached）新建一个 tmux 会话运行指定命令。
 * @param {string} name 会话名
 * @param {string} cwd 工作目录
 * @param {string} shellCommand 交给 tmux 的 shell 命令（单一字符串）
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function newDetached(name, cwd, shellCommand) {
  return tmux(['new-session', '-d', '-s', name, '-c', cwd, shellCommand]);
}

/**
 * 向目标会话/pane 注入文本。
 * 通过 buffer + bracketed paste 传递，天然支持多行与特殊字符，避免 send-keys 的引号地狱；
 * 随后按需回车提交。
 * @param {string} target tmux target（会话名或 session:win.pane）
 * @param {string} text 要注入的文本
 * @param {object} [opts]
 * @param {boolean} [opts.enter=true] 注入后是否回车提交
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function sendText(target, text, opts = {}) {
  const enter = opts.enter !== false;
  const buf = 'ccr-inject';

  let r = tmux(['load-buffer', '-b', buf, '-'], { input: text });
  if (r.status !== 0) {
    return r;
  }
  // -p: bracketed paste（TUI 视为粘贴，多行安全）；-d: 粘贴后删除该 buffer
  r = tmux(['paste-buffer', '-b', buf, '-p', '-d', '-t', target]);
  if (r.status !== 0) {
    return r;
  }
  if (enter) {
    r = tmux(['send-keys', '-t', target, 'Enter']);
  }
  return r;
}

/**
 * 抓取目标会话可见/滚动区文本（读平面的兜底，优先仍用 transcript）。
 * @param {string} target
 * @param {number} [lines=200] 向上回溯的行数
 * @returns {string}
 */
function capturePane(target, lines = 200) {
  const r = tmux(['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
  return r.status === 0 ? (r.stdout || '') : '';
}

/**
 * 杀掉一个 tmux 会话。
 * @param {string} name
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function killSession(name) {
  return tmux(['kill-session', '-t', name]);
}

module.exports = {
  isInstalled,
  hasSession,
  listPanes,
  findTargetByTty,
  normalizeTty,
  newDetached,
  sendText,
  capturePane,
  killSession,
};
