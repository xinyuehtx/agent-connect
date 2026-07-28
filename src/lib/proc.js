'use strict';

const { spawnSync } = require('child_process');

/**
 * 判断进程是否存活。
 * signal 0 不发送真实信号，仅做存在性/权限探测：
 *   - 成功        → 存活
 *   - EPERM       → 存在但非本用户（仍视为存活）
 *   - ESRCH/其他  → 不存在
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  if (!pid || typeof pid !== 'number') {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 获取进程当前挂载的 tty（如 "s005"），无控制终端返回 null。
 * @param {number} pid
 * @returns {string|null}
 */
function ttyOf(pid) {
  const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) {
    return null;
  }
  const t = (r.stdout || '').trim();
  return t && t !== '??' && t !== '?' ? t : null;
}

/**
 * 获取进程的当前工作目录（macOS 用 lsof）。
 * @param {number} pid
 * @returns {string|null}
 */
function cwdOf(pid) {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (r.status !== 0) {
    return null;
  }
  const line = (r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/**
 * 列出所有进程：pid / tty / 完整命令行。
 * 用于没有原生运行态注册表的 agent（如 qodercli）做进程发现。
 * @returns {Array<{pid:number, tty:string, command:string}>}
 */
function listProcesses() {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,tty=,command='], { encoding: 'utf8' });
  if (r.status !== 0) {
    return [];
  }
  const out = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) {
      out.push({ pid: Number(m[1]), tty: m[2], command: m[3] });
    }
  }
  return out;
}

/**
 * 向进程发送信号（吞掉异常，返回是否成功）。
 * @param {number} pid
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean}
 */
function killPid(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  isAlive, ttyOf, cwdOf, listProcesses, killPid,
};
