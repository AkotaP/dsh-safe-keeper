import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 自动禁用条目的标记注释，用于和用户手动禁用区分 */
export const AUTO_DISABLE_MARKER = "# auto-disabled by dsh-safe";

/**
 * 读取 cordis.patch.yml 的原始文本（不存在则返回空串）。
 * @param {string} file
 * @returns {string}
 */
export function readPatch(file) {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

/**
 * 判断 patch 文件里某个 id 是否已经带 `disabled: true`。
 * 用轻量块解析：按 `- id: ` 切块，检查目标块内是否有 disabled: true。
 * @param {string} content
 * @param {string} id
 * @returns {boolean}
 */
export function isDisabled(content, id) {
  const blocks = content.split(/^- id: /m);
  for (const block of blocks) {
    const firstLineEnd = block.indexOf("\n");
    const blockId = (firstLineEnd === -1 ? block : block.slice(0, firstLineEnd)).trim();
    if (blockId !== id) continue;
    return /^\s+disabled:\s*true\s*$/m.test(block);
  }
  return false;
}

/**
 * 向 cordis.patch.yml 追加一条自动禁用条目。
 * 已禁用则返回 false（不重复写）。
 * @param {string} file
 * @param {string} id
 * @param {string} name 模块名，仅用于注释
 * @returns {boolean} 是否真的写入了
 */
export function disablePlugin(file, id, name) {
  const content = readPatch(file);
  if (isDisabled(content, id)) return false;

  const entry = `- id: ${id}\n  disabled: true\n`;

  // 空数组 []：把末尾的 [] 替换成条目，避免产生非法 YAML
  if (/\[\]\s*$/.test(content)) {
    writeFileSync(file, content.replace(/\[\]\s*$/, entry));
    return true;
  }

  // 正常追加
  const trimmed = content.replace(/\s*$/, "");
  writeFileSync(
    file,
    (trimmed ? trimmed + "\n" : "") + `\n${AUTO_DISABLE_MARKER}: ${name}\n` + entry,
  );
  return true;
}
