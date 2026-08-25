import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stateFile } from "./paths.js";

/**
 * 读取启动器状态。
 * @param {string} home
 * @returns {{autoDisabled: Record<string, {name: string, disabledAt: string}>}}
 */
export function loadState(home) {
  const file = stateFile(home);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { autoDisabled: {}, ...parsed };
  } catch {
    return { autoDisabled: {} };
  }
}

/**
 * 写回启动器状态。
 * @param {string} home
 * @param {object} state
 */
export function saveState(home, state) {
  const file = stateFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/**
 * 记录一个被自动禁用的插件。
 * @param {string} home
 * @param {string} id
 * @param {string} name
 */
export function recordAutoDisabled(home, id, name) {
  const state = loadState(home);
  state.autoDisabled[id] = { name, disabledAt: new Date().toISOString() };
  saveState(home, state);
}

/**
 * 返回所有被自动禁用的插件（按禁用时间排序）。
 * @param {string} home
 * @returns {{id: string, name: string, disabledAt: string}[]}
 */
export function listAutoDisabled(home) {
  const state = loadState(home);
  return Object.entries(state.autoDisabled)
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.disabledAt.localeCompare(b.disabledAt));
}
