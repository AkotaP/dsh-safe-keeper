# dsh-safe-keeper

DSH 启动器：自动禁用启动失败的插件并重启，支持安全模式、安全重启、日志与配置。

## 它解决什么问题

DSH 的启动是「fail-loud」的——只要有一个插件启动失败，整个 DSH 就退出。`dsh-safe-keeper` 作为 DSH 的父进程，在 DSH 退出后从容地：

1. 从错误信息里定位是哪个插件失败了；
2. 把该插件写进 `cordis.patch.yml` 的 `disabled: true`；
3. 重新拉起 DSH（带重试上限，防止死循环）。

## 安装

### 1. 获取本项目

```bash
# 方式 A：clone 本项目到本地（推荐）
git clone https://github.com/AkotaP/dsh-safe-keeper.git

# 方式 B：下载本项目 ZIP
# 在 GitHub 仓库页面点 Code → Download ZIP，解压到本地
```

### 2. 安装 / 使用（三选一）

先进入项目目录（上一步 clone 或解压出来的 `dsh-safe-keeper` 文件夹）

```bash
cd dsh-safe-keeper
```

然后在项目目录下，三选一进行安装：

```bash
# 方式一：全局安装（推荐）
npm install -g .

# 方式二：开发时直接 link（改代码立即生效）
npm link

# 方式三：不安装，直接用 node 跑
node bin/dsh-safe.js <profile>
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
dsh-safe restart [选项]                 请父进程安全重启当前 DSH
dsh-safe status                         查看运行中的实例与待处理重启请求
dsh-safe skill [list|install]           管理随包分发的 skill
dsh-safe hooks                          列出 hooks 目录里的脚本与事件
dsh-safe hooks run <event>              手动触发一个事件（调试）
dsh-safe hooks dir                      在文件管理器中打开 hooks 目录
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
| `restart` | 见下 | 安全重启配置（对象），直接编辑 `config.json` |

`restart` 子项：

| 键 | 默认值 | 说明 |
|----|--------|------|
| `enabled` | `true` | 总开关；`false` 时既不监听控制端口也不看请求文件 |
| `requireEscalation` | `true` | 会话内触发重启是否必须提权：`true` 时不开控制端口、只能写请求文件（需 full-access 批准）；`false` 改用控制端口，会话内可直接重启 |
| `pollIntervalMs` | `500` | 请求文件通道的轮询间隔（毫秒） |
| `graceMs` | `5000` | POSIX 上 SIGTERM 后等多久再 SIGKILL |
| `settleMs` | `500` | 重启前等旧进程退出、释放端口的时间 |
| `maxPerSession` | `0` | 单次生命周期内允许的重启次数，`0` = 不限 |
| `noOpen` | `true` | 重启 web profile 时自动追加 `--no-open`，不再弹新浏览器窗口 |

```bash
dsh-safe config set retryLimit 5
dsh-safe config set logRetention 2000
dsh-safe config set logLevel debug
```

`hooks` 是个配置对象，`config set` 不处理它，直接编辑 `config.json`；详见下面的「启动 hooks」。

## 安全模式

`dsh-safe --safe <profile>` 会**只禁用第三方插件**（通过 `dsh plugin add` 安装的），保留 DSH 自带的 bundle（`@deepseek-ai/*`），然后启动。

这样即使某个第三方插件把 DSH 搞崩了，也能用安全模式启动一个「干净」的 DSH 来恢复。

## 安全重启（restart）

用 DSH 开发、安装、修改插件时经常需要重启，但 **DSH 不能自己 kill 自己**——那等于把正在执行这次工具调用的宿主连根拔掉。dsh-safe 是 DSH 的父进程，所以由它来结束并重新拉起 DSH：

```bash
dsh-safe restart --reason "安装了 xxx 插件"   # 在 DSH 会话里执行（工具沙箱内也能用）
dsh-safe restart --wake "接着验证插件是否加载"  # 重启后把这句话投回会话，agent 自动续跑
dsh-safe restart --dry-run                    # 只看会重启哪个实例，不发请求
dsh-safe status                               # 列出运行中的实例与待处理请求
```

行为：

- 重启请求**不消耗** `retryLimit`，也**不会**触发插件自动禁用：重启是用户意图，不是启动失败；
- DSH 按原来的 profile 和参数重新启动；
- 当前 DSH 里的会话 / 工具调用会中断（预期行为），Web GUI 重连后继续；
- `restart.maxPerSession` 是防死循环上限（默认 `0` = 不限），避免某个插件每次启动都请求重启；
- 重启 web profile 时自动补 `--no-open`：GUI 页面已经在浏览器里开着，不再弹新窗口（首次启动照旧打开；headless 不补——`--no-open` 只由 web-app bundle 注册，传过去会变成未知参数）；
- `--wake <文本>`：重启会掐断当前回合，所以可以在请求重启时附一句话；DSH 回来后 dsh-safe 把它作为一条**用户消息**投回同一会话，agent 就能自动接着干。**留空则不投递**；投递失败只记日志**降级**，不影响启动。会话 id 取自 agent shell 里的 `DSH_SESSION_ID`，无需用户传。

### 两条通道

| 通道 | 谁用 | 原理 |
|------|------|------|
| 请求文件 | 外部终端；会话内（**默认走这条**） | 往 `$DSH_HOME/dsh-safe/runs/<runId>/restart.request.json` 写请求，父进程轮询消费（持续监听，可多次重启） |
| 控制端口 | 会话内（仅 `restart.requireEscalation=false`） | dsh-safe 在 `127.0.0.1` 随机端口监听，只认带随机 token 的 `restart` 请求；port/token 写在 `runs/<runId>/run.json`，CLI 读回 |

**默认为什么要提权**：`restart.requireEscalation=true`（默认）时不启动控制端口、也不把 token 落盘，会话内只能写 `$DSH_HOME/.../restart.request.json`——而这条路径在 workspace-write 沙箱里不可写，于是 agent 必须用 `danger-full-access` 申请一次批准，**重启经过用户明示同意**。

注意这道闸门**不是自己造的开关，而是拿沙箱边界当闸门**：如果会话文件策略本身就是 `danger-full-access`（或工作区恰好覆盖了 DSH_HOME），写入会直接成功、一步到位，就没有人工确认了。`dsh-safe status` 只能读配置、读不到沙箱策略，所以它显示的是「按配置」而非「实际会不会被拦」。

把它设为 `false` 则改用 loopback 控制端口：会话内直接重启、不再需要批准（`status` 显示「重启通道 可用（127.0.0.1:xxxxx）」，并支持 `ping` 探测，不会触发重启）。

为什么当初要 socket：DSH 的工具沙箱（`workspace-write`）只允许写工作区和本会话临时目录，写 `$DSH_HOME/dsh-safe/...` 会被拒绝；**而且 DSH 不会把父进程的环境变量透传给工具进程**（工具进程的环境是重建的，只有 `DSH_HOME` 一类的 DSH 自有变量），所以 `DSH_SAFE_CONTROL_PORT` 到不了会话里。控制端口因此把 port/token 落盘到运行记录（沙箱里读文件是允许的）。运行实例信息放在 `$DSH_HOME/dsh-safe/runs/<runId>/`，每次启动生成新 runId，退出时清理。


### 配套 skill

`skills/dsh-safe-restart/` 是随包分发的 skill，教 DSH 里的 agent 怎么安全重启、以及重启前后要做什么：

```bash
dsh-safe skill                              # 查看安装状态
dsh-safe skill install                      # 安装到 $DSH_HOME/skills
dsh-safe skill install --project .          # 或安装到 <项目>/.dsh/skills
```

DSH 会实时监听 skill 目录，装完通常不用重启；列表里没出现就重新载入会话。

## 启动 hooks

`dsh-safe` 可以在每次启动 DSH 之前 / 之后自动跑一组本地脚本。典型用途：DSH 升级 / 重装后自动重打 UI 补丁、启动前准备目录或同步配置、记录每次启动。

### 用法

把 `.mjs` 文件丢进 `$DSH_HOME/dsh-safe/hooks/` 就生效，无需注册：

```bash
dsh-safe hooks                    # 列出 hook 及其注册的事件（含被禁用的）
dsh-safe hooks run beforeLaunch   # 手动触发一个事件（调试）
dsh-safe hooks dir                # 在文件管理器中打开 hooks 目录
```

顺序按文件名自然排序（`2-x.mjs` 在 `10-y.mjs` 之前），用数字前缀控制先后。

### hook 写法

只关心启动前：

```js
// $DSH_HOME/dsh-safe/hooks/10-ui-labels.mjs
export default async ({ logger, home, profile, attempt }) => {
  logger("info", "启动前检查补丁");
};
```

需要多个事件：

```js
export const hooks = {
  beforeLaunch: async (ctx) => {},
  afterExit: async ({ code, stderr }) => {},
  pluginDisabled: async ({ pluginId, pluginName }) => {},
};
```

| 事件 | 触发点 | 额外 ctx |
|------|--------|---------|
| `beforeLaunch` | 每次真正启动 DSH 之前（含自动禁用后的重试） | `attempt`（从 1 开始） |
| `afterExit` | DSH 进程退出之后（正常与安全模式都会触发） | `code`、`stderr` |
| `pluginDisabled` | 自动禁用某个插件成功之后 | `pluginId`、`pluginName` |

ctx 里还有 `home`、`profile`、`profileDir`、`args`、`safe`、`config`，以及 `logger(level, message)`（已带 `[hook:<文件名>]` 前缀）。hook 不要往 stdout 写，统一用 `ctx.logger`。

### 配置

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 10000,
    "failure": "warn",
    "disabled": []
  }
}
```

| 键 | 默认值 | 说明 |
|----|--------|------|
| `enabled` | `true` | 总开关；`false` 时一个 hook 都不跑 |
| `timeoutMs` | `10000` | 单个 hook 的超时（毫秒） |
| `failure` | `"warn"` | `"warn"` 只记日志；`"abort"` 时 `beforeLaunch` 失败会拒绝启动 |
| `disabled` | `[]` | 要跳过的 hook 文件名（basename） |

### 注意

- hook 每次启动（含自动禁用后的每次重试）都会跑，**写文件前先比对内容**保证幂等；否则每次启动都改 mtime，`dsh-client-hmr` 会误判为变化并重载 UI；
- 同一 hook 文件在一次 `dsh-safe` 进程里只求值一次，模块级状态跨事件、跨重试存活；要每次执行都初始化，就写在函数体里；
- 超时只能放弃等待，hook 可能仍在后台继续跑；
- hook 与 `dsh-safe` 同权限运行，只应放入可信脚本；
- 没有 hooks 目录时，行为与之前完全一致。

## 日志

日志写在 `$DSH_HOME/dsh-safe/logs/dsh-safe.log`，用 `dsh-safe logs` 查看。日志按 `logRetention` 条数自动截断（保留最新）。

## 工作原理

1. `spawn dsh --profile <name> <args>`，捕获 stderr 和退出码；
2. 退出码为 0 → 正常退出，打印「本次自动禁用了哪些插件」；
3. 退出码非 0 → 跑 `dsh --dump-config` 拿到插件清单（id ↔ 模块名 ↔ 来源 bundle），从 stderr 里提取失败插件的模块名；
4. 往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 追加 `disabled: true`（带 `# auto-disabled by dsh-safe` 标记，与用户手动禁用区分；DSH 自带插件 `cordis:*` / `@deepseek-ai/*` 不自动禁用，提示手动处理）；
5. 重启，超过 `retryLimit` 次仍失败则放弃；
6. 收到重启请求（控制端口或请求文件）时，终止当前 DSH 并按原参数重启——这一步优先于退出码判定，所以被终止产生的非 0 退出码不会被误当成插件失败。

## 限制

- 依赖 DSH 的 `--dump-config` 输出格式和启动错误信息格式，DSH 大版本更新可能变化；
- 安全模式按 profile 的 `dsh.profile.bundles` 动态区分自带/第三方（`@deepseek-ai/*` 视为自带），读不到时回退硬编码白名单；
- 自动禁用只处理「能定位到失败插件」的情况；定位不到时会提示手动处理。
- 自动禁用跳过 DSH 自带插件（`cordis:*` / `@deepseek-ai/*`），自带插件失败需手动处理（升级 DSH 或检查配置）；
- 启动 hooks 的超时只能放弃等待、无法真正取消，超时的 hook 可能仍在后台运行；
- hooks 与 `dsh-safe` 同权限运行，只应放入可信脚本；
- 重启的控制端口只监听 loopback、只认随机 token、只支持 restart 一个动作；网络被限制时退化为请求文件通道；
- Windows 上重启用 `taskkill /T /F` 强制结束进程树（DSH 会话按消息持久化，最多丢正在写的一条）；其它平台先 SIGTERM 再 SIGKILL；
- 运行实例的存活判定基于父进程 pid，pid 复用是已知限制（只用于「这个 dsh-safe 还在不在」的粗判）。

## 测试

```bash
# 单元测试（纯函数 / loopback / 真实子进程，无需 dsh）
node test/core.test.js
node test/hooks.test.js
node test/restart.test.js

# 集成测试（需要真实 dsh，会 spawn 子进程捕获输出）
node test/integration.test.js
node test/launch.test.js
node test/safe.test.js
node test/restart-e2e.test.js   # 用假 dsh 验证重启链路，需要 danger-full-access
```
