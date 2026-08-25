# dsh-safe-keeper

DSH 启动器：自动禁用启动失败的插件并重启，支持安全模式、日志与配置。

## 它解决什么问题

DSH 的启动是「fail-loud」的——只要有一个插件启动失败，整个 DSH 就退出。`dsh-safe-keeper` 作为 DSH 的父进程，在 DSH 退出后从容地：

1. 从错误信息里定位是哪个插件失败了；
2. 把该插件写进 `cordis.patch.yml` 的 `disabled: true`；
3. 重新拉起 DSH（带重试上限，防止死循环）。

## 安装

```bash
# 方式一：全局安装（推荐）
npm install -g <dsh-safe 目录>

# 方式二：开发时直接 link
cd <dsh-safe 目录> && npm link

# 方式三：不安装，直接用 node 跑
node <dsh-safe 目录>/bin/dsh-safe.js <profile>
```

要求：`dsh` 已在 PATH 中，Node >= 18。

## 用法

```bash
dsh-safe <profile> [args...]            正常启动（自动禁用 + 重启）
dsh-safe --safe <profile> [args...]     安全模式（禁用第三方插件）
dsh-safe config                         查看配置
dsh-safe config set <key> <value>       修改配置
dsh-safe logs [N]                       查看最近 N 条日志（默认 50）
dsh-safe open-config <profile>          在文件管理器中打开禁用配置文件
dsh-safe --help                         显示帮助
```

示例：

```bash
dsh-safe web                              # 启动 web，等价于 dsh --profile web
dsh-safe web --no-open                    # 透传参数给 dsh
dsh-safe --safe web                       # 安全模式启动 web
dsh-safe open-config web                  # 打开 web 的 cordis.patch.yml
```

## 配置

配置文件在 `$DSH_HOME/dsh-safe/config.json`：

| 键 | 默认值 | 说明 |
|----|--------|------|
| `retryLimit` | `3` | 自动禁用后最多重启几次（超过则放弃） |
| `logRetention` | `1000` | 日志保留条数上限 |
| `logLevel` | `info` | 日志级别：`error` \| `warn` \| `info` \| `debug` |

```bash
dsh-safe config set retryLimit 5
dsh-safe config set logRetention 2000
dsh-safe config set logLevel debug
```

## 安全模式

`dsh-safe --safe <profile>` 会**只禁用第三方插件**（通过 `dsh plugin add` 安装的），保留 DSH 自带的 bundle（`dsh-base` / `dsh-web-app` / `dsh-headless`），然后启动。

这样即使某个第三方插件把 DSH 搞崩了，也能用安全模式启动一个「干净」的 DSH 来恢复。

## 日志

日志写在 `$DSH_HOME/dsh-safe/logs/dsh-safe.log`，用 `dsh-safe logs` 查看。日志按 `logRetention` 条数自动截断（保留最新）。

## 工作原理

1. `spawn dsh --profile <name> <args>`，捕获 stderr 和退出码；
2. 退出码为 0 → 正常退出，打印「本次自动禁用了哪些插件」；
3. 退出码非 0 → 跑 `dsh --dump-config` 拿到插件清单（id ↔ 模块名 ↔ 来源 bundle），从 stderr 里提取失败插件的模块名；
4. 往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 追加 `disabled: true`（带 `# auto-disabled by dsh-safe` 标记，与用户手动禁用区分）；
5. 重启，超过 `retryLimit` 次仍失败则放弃。

## 限制

- 依赖 DSH 的 `--dump-config` 输出格式和启动错误信息格式，DSH 大版本更新可能变化；
- 安全模式的「DSH 自带 bundle」是硬编码白名单（`dsh-base` / `dsh-web-app` / `dsh-headless`）；
- 自动禁用只处理「能定位到失败插件」的情况；定位不到时会提示手动处理。
