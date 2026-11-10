import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录：优先 $DSH_HOME，其次 ~/.dsh */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件的运行数据（config.json / run.log / last-run.txt） */
export function pluginHome() {
  return join(dshHome(), 'persona-distill')
}

/** 蒸馏工作区（distill.md / state.json / pending.md / archive） */
export function personaHome() {
  return join(dshHome(), 'persona')
}

/** 人格面板 —— 全局面板，DSH 每次会话都会读它 */
export function agentsFile() {
  return join(dshHome(), 'AGENTS.md')
}
