# dsh-safe-keeper

DSH（DeepSeek Harness）的启动器：作为 DSH 的父进程，在 DSH 因插件启动失败而退出后，自动定位失败插件、写禁用、重启。另提供安全模式、安全重启（配套 skill）、日志、配置。

## 为什么存在

DSH 的启动是 **fail-loud** 的：只要有一个插件启动失败（import 失败 / 激活失败 / 依赖服务缺失），整个 DSH 就 `exit(1)`，不会自动禁用坏插件。dsh-safe-keeper 站在 DSH 进程**外面**做这件事——DSH 死了，dsh-safe-keeper 还活着，可以慢慢收拾。

## 目录结构

```
dsh-safe/
├── package.json          # name: dsh-safe-keeper, bin: {dsh-safe: bin/dsh-safe.js}, type: module
├── bin/
│   └── dsh-safe.js       # CLI 入口（手写参数解析，零依赖）
├── lib/
│   ├── launcher.js       # 核心：spawn→检测→禁用→重启 + 安全模式
│   ├── dsh.js            # spawn dsh、解析 --dump-config、读 profile bundles、提取失败插件
│   ├── patch.js          # 读写 cordis.patch.yml（含空数组 [] 处理）
│   ├── config.js         # 配置读写（config.json）
│   ├── hooks.js          # 启动 hooks（发现 / 执行 / 超时）
│   ├── restart.js        # 运行实例记录、重启请求文件、监听器、进程树终止
│   ├── wake.js           # 重启唤醒消息：扫 token URL、换 cookie、投递（失败降级）
│   ├── control.js        # 重启控制端口（loopback + token）服务端 / 客户端
│   ├── logger.js         # 日志（文件 + 保留上限截断）
│   ├── state.js          # 状态（记录自动禁用的插件）
│   └── paths.js          # 路径解析（DSH_HOME / profile 目录 / dsh-safe 目录）
├── skills/
│   └── dsh-safe-restart/SKILL.md  # 随包分发的 skill（教 agent 安全重启）
├── test/
│   ├── core.test.js      # 单元测试（纯函数）
│   ├── hooks.test.js     # 启动 hooks 单元测试
│   ├── restart.test.js   # 运行实例 / 请求文件 / 控制端口 / 终止进程 单元测试
│   ├── wake.test.js      # 唤醒消息投递单元测试（假 HTTP 服务）
│   ├── integration.test.js  # spawnDsh + getPluginMap 集成测试
│   ├── launch.test.js    # 完整 launch 链路集成测试
│   ├── safe.test.js      # 安全模式集成测试
│   └── restart-e2e.test.js  # 假 dsh 驱动的重启链路 e2e
└── README.md
```

零依赖：只用 Node 内置模块（`node:fs` / `node:child_process` / `node:path` / `node:os`）。

## 工作原理

### 启动流程（launch）

```
dsh-safe <profile> [args...]
  ├─ 写运行实例记录（runs/<runId>/run.json）
  ├─ 监听请求文件（默认；requireEscalation=false 时另起控制端口）
  └─ spawn dsh --profile <profile> <args>   （捕获 stderr + 退出码）
       ├─ 收到重启请求 → 终止进程树 → 按原参数重启（不算失败、不禁用插件）
       ├─ 退出码 0 → 打印「本次自动禁用了哪些插件」，结束
       └─ 退出码 ≠ 0 →
            ├─ 超过 retryLimit → 放弃
            ├─ 跑 dsh --dump-config 拿插件清单
            ├─ 从 stderr 提取失败插件模块名
            ├─ 往 cordis.patch.yml 追加 disabled: true
            └─ 重启（回到 spawn）
```

### 失败检测（findFailedPlugins）

从 stderr 提取失败插件模块名，覆盖 DSH 的三种稳定错误格式：

1. `failed to import/apply loader entry <id> (<name>): ...`（import/apply 失败）
2. `plugin(s) failed to load: <name1>, <name2>`（fiber-less 且未禁用）
3. `<name>: <error>` 行（激活失败）

用 `--dump-config` 拿到的已知插件名集合过滤，避免误报（错误堆栈里可能提到正常插件名）。

### 插件清单（parseDumpConfig）

`dsh --profile <name> --dump-config` 输出 YAML，每个 entry 格式：

```yaml
# == @deepseek-ai/dsh-base          ← 来源 bundle 注释
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
```

解析出：
- `entries`: `[{id, name, source}]` 完整列表
- `byName`: `Map<name, id[]>`（一个模块名可能对应多个 id）

**关键坑：一个模块名可能对应多个 entry id**。例如 `@deepseek-ai/dsh-tool-subagent` 有 `tool-subagent`（spawn）和 `tool-subagent-fork`（fork）两个 id。所以必须用 `name → id[]` 映射，禁用时全部禁用，安全模式也要用 `entries` 列表而不是 `byName` 去重。

### 自动禁用（disablePlugin）

往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 追加：

```yaml
# auto-disabled by dsh-safe: <模块名>
- id: <id>
  disabled: true
```

- 带 `# auto-disabled by dsh-safe` 标记，与用户手动禁用区分（需求：不影响用户手动禁用）。
- 追加不覆盖，保留用户已有条目。
- **空数组 `[]` 处理**：cordis.patch.yml 初始是 `[]`，直接追加 `- id:` 会产出非法 YAML，所以要把末尾的 `[]` 替换成条目。
- **自带插件保护**：`cordis:*` 和 `@deepseek-ai/*` 的插件启动失败时不自动禁用（禁了可能连锁破坏），提示手动处理（升级 DSH 或检查配置）。

### 安全模式（--safe）

`dsh-safe --safe <profile>` 只禁用**第三方插件**，保留 DSH 自带的 bundle。

- 第三方识别：读 profile 的 `package.json` 的 `dsh.profile.bundles`，非 `@deepseek-ai/*` scope 的 bundle 视为第三方；`--dump-config` 的 `# == <bundle名>` 来源注释落在第三方集合里的 entry 即禁用。
- 读不到 bundles 时回退硬编码白名单（`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` / `@deepseek-ai/dsh-headless`）。
- 实现：把禁用条目写进**临时文件** `$DSH_HOME/dsh-safe/safe-mode.patch.yml`，用 `dsh --patch <临时文件>` 启动。**不修改 cordis.patch.yml**，所以安全模式是临时的、一次性的，下次正常启动原配置原样生效。

### 安全重启（restart）

DSH 不能自己 kill 自己（那会掐断正在执行的工具调用），所以重启请求发给父进程 dsh-safe，由它终止当前 DSH 并按**原来的 profile / 参数**重新拉起。

两条通道：

| 通道 | 谁用 | 原理 |
|---|---|---|
| 请求文件（默认） | 外部终端；会话内（提权后） | 往 `runs/<runId>/restart.request.json` 写请求，父进程 `watchRestartRequest()` **持续**轮询并原子消费（先 rename 再解析） |
| 控制端口（可选） | 会话内，仅在 `requireEscalation=false` 时 | `startControlServer()` 绑定 `127.0.0.1:0`，每个 launch 生成随机 token，并通过 `updateRunControl()` 落盘到运行记录；CLI 用 `readRunControl()` 取到 port/token，发 `{token, action:"restart"}`，服务端校验后先回执再触发重启（`action:"ping"` 只回执、不重启，供 `status` 探测） |

**默认为什么只能走请求文件**：DSH 的工具沙箱（`workspace-write`）只允许写工作区和本会话临时目录，写 `$DSH_HOME/dsh-safe/...` 会被拒绝（实测报 Access denied）——这正是提权门要做的事：默认模式下不提供免批准的旁路，agent 只能申请 `danger-full-access` 一次。

关键点：

- 运行实例信息写在 `$DSH_HOME/dsh-safe/runs/<runId>/run.json`（父进程 pid / profile / args）；`beginRun` 顺手清理 pid 已消失的历史实例，`endRun` 在 launch 的 finally 里清理本次实例。
- env 传给 DSH：`DSH_SAFE_RUN_ID`、`DSH_SAFE_BIN`（CLI 绝对路径，未全局安装也能调用）、`DSH_SAFE_CONTROL_PORT`、`DSH_SAFE_CONTROL_TOKEN`。
- **这些变量到不了 agent 的 shell（重要更正）**：DSH 工具进程的环境是**重建**的——`dsh-pwsh-local` 的 `spawnSpec().env = {...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv}`，只带 `NO_COLOR/PAGER/GIT_PAGER` 加 `ctx.shellEnv` 注册的 DSH 事实。实测 pwsh 里只有 `DSH_HOME` / `DSH_SESSION_ID` / `DSH_SHELL` / `DSH_WEB_URL`，父进程其它变量一律不透传。（`PATH`/`USERPROFILE` 是沙箱/OS 层为进程可用性补的，**不能**当作透传证据——早期就是在这里判断错的。）
- 因此控制端口与 token 必须落盘：`startControlServer()` 之后调 `updateRunControl()` 写进 `runs/<runId>/run.json` 的 `control` 块；CLI 拿不到 env 时用 `readRunControl()` 从运行记录取（沙箱里读 `$DSH_HOME` 允许，写才被拒）。
- 重启**优先于退出码判定**：被终止的进程退出码必然非 0，若按失败处理会误触发插件自动禁用。
- 重启不消耗 `retryLimit`：`failures` 与 `restarts` 各自计数，「失败重试」和「用户重启」互不污染。
- `restart.maxPerSession`（默认 0 = 不限）防止插件每次启动都请求重启导致的死循环。
- 每次重启前 `sleep(restart.settleMs)`，等旧进程释放监听端口，避免重启后 EADDRINUSE 被误判为插件故障。
- 终止进程树：Windows 用 `taskkill /pid <pid> /t /f`（`shell: true` 时 child 是 cmd.exe，只 kill 它会留下 dsh 孤儿），失败兜底 `child.kill()`；其它平台先 SIGTERM、`graceMs` 后 SIGKILL。
- CLI 的 `restart`：`requireEscalation=false` 时先试控制端口，失败退回请求文件；默认模式直接用请求文件。文件通道按存活的 run 定位，多个实例要求 `--profile` / `--run` 指定。
- **默认 `restart.requireEscalation=true`**：不启动控制端口、不落 token，会话内只能写请求文件——而写 `$DSH_HOME` 会被沙箱拒绝，于是 agent 必须用 `danger-full-access` 申请一次批准，重启永远过用户明示同意。设为 `false` 才走 loopback 控制端口（无需批准）。
- 重启 web profile 时用 `buildRestartArgs()` 追加 `--no-open`（`restart.noOpen`，默认 true）：`--no-open` 是 `dsh-web-app` 的 `web-startup` 插件注册的 commander 参数，只有 web profile 认识，所以先用 `isWebProfile()`（读 `dsh.profile.bundles`）判断，避免给 headless 传成未知参数；首次启动不追加。
- **唤醒消息（`--wake`）**：重启会掐断当前回合，所以 agent 可以在请求里附一句话；DSH 起来后 dsh-safe 把它投回同一会话（`session/prompt`，`mode:"queue"`）。留空 → 不投递；投递失败 → 只记日志降级，绝不阻塞启动。会话 id 来自 agent shell 的 `DSH_SESSION_ID`。
- 配套 skill：`skills/dsh-safe-restart/`，用 `dsh-safe skill install` 装到 `$DSH_HOME/skills`（DSH 的 skill-filesystem 从这里加载）。

### 启动 hooks（lib/hooks.js）

`$DSH_HOME/dsh-safe/hooks/` 下的 `*.mjs` 在启动前后自动执行，drop-in 生效（丢文件即可，无需注册）。

| 事件 | 触发点 | 额外 ctx |
|---|---|---|
| `beforeLaunch` | 每次真正 spawn DSH 之前（含禁用后的重试；正常与安全模式都触发） | `attempt` |
| `afterExit` | `spawnDsh` 返回之后 | `code`、`stderr` |
| `pluginDisabled` | 自动禁用某插件成功之后 | `pluginId`、`pluginName` |
| `restartRequested` | 收到重启请求、旧 DSH 已终止之后（重启前） | `reason`、`requestedAt`、`requester`、`via` |

- 排序：`a.localeCompare(b, "en", { numeric: true })`，`2-x.mjs` 排在 `10-y.mjs` 之前；每次 emit 重新 readdir（运行中丢文件即生效）。
- 导出形态：`export default`（只服务 `beforeLaunch`）或 `export const hooks = { <event>: fn }`。
- 每个 hook 单独 try/catch + 超时（`config.hooks.timeoutMs`，默认 10000ms）；超时只能放弃等待，无法取消。
- 默认不阻断启动：失败记 warn + stderr 一行；只有 `hooks.failure: "abort"` 时 `beforeLaunch` 失败才拒绝启动。
- 四处 emit 收敛在 `launcher.js` 的 `emitBeforeLaunch()` / `spawnWithHooks()`，防漏点（安全模式也走同一路径）。
- CLI：`dsh-safe hooks`（列出）、`dsh-safe hooks run <event>`（调试）、`dsh-safe hooks dir`（打开目录）。

## 关键设计决策与坑

1. **patch 层语义**：cordis.patch.yml 里「新增插件」必须用 `insert`，直接写 `- id: xxx` 会被当成「覆盖已有条目」而报 `entry not found`。但「禁用已有插件」用 `- id: xxx / disabled: true`（覆盖 disabled 字段）是对的，因为被禁用的插件本来就在 bundle 层。
2. **Windows spawn**：npm 的 bin 是 `.cmd` shim，`spawn("dsh", args, {shell: true})` 才能跑（与 DSH 自己 `dsh plugin` 里 spawn pnpm 的方式一致）。会触发 Node 的 DEP0190 弃用警告，可接受（args 是用户自己传的，无注入风险）。
3. **中断处理**：launch 里监听 SIGINT/SIGTERM，用户 Ctrl+C 时不再自动重启（否则退出码 130 会被误判为启动失败）。
4. **重试上限**：`retryLimit` 防止「禁用没生效 → 重启又失败 → 又禁用」死循环。
5. **DSH_HOME 解析**：与 DSH 一致，`$DSH_HOME` 环境变量优先，否则 `~/.dsh`。
6. **hooks 绝不 emit 在 `spawnDsh`**：`lib/dsh.js` 的 `spawnDsh()` 被 `getPluginMap()` 复用（跑 `dsh --dump-config`），emit 放进去会让「启动失败 → 取清单」这一步递归触发 hook，最坏死循环。emit 只放在 launcher 真正启动 DSH 的调用处。
7. **hooks 在父进程内 `await import()`，不 spawn 子进程**：Windows 无 shell 引用问题、重启循环近零开销、直接复用 paths/logger/config；代价是坏 hook 会波及其它 hook，用「每个 hook 单独 try/catch + 超时」补回来。
8. **强制 `.mjs`**：hooks 目录没有 `package.json`，`.js` 会被 Node 按 CommonJS 解析，`export default` 直接报错；不为它自动写 `package.json`（隐式副作用）。
9. **hooks 幂等是 hook 作者的责任**：hook 每次启动（含自动禁用后的重试）都跑，写文件前必须先比对内容，否则每次改 mtime 会让 `dsh-client-hmr` 的 stat 轮询误判并重载 UI。
10. **ESM 只求值一次**：同一 hook 文件在一次 dsh-safe 进程里只 import 一次，模块级状态跨事件 / 跨重试存活；要每次执行都初始化，就写在函数体里。
11. **hooks 配置是对象**：`loadConfig` 顶层浅合并会整体覆盖 `hooks`，所以对 `hooks` 单独做一次合并补默认值；不扩展 `coerceConfigValue`（只认顶层标量，为数组/对象写点号路径解析是过度设计）。
12. **重启不是失败**：launcher 里重启分支放在 `result.code === 0` 判定之前，且不消耗 `retryLimit`；`failures` 与 `restarts` 各自计数。
13. **spawn 同步抛错也要接住**：受限沙箱下 `spawn(..., {stdio:"pipe"})` 会同步抛 EPERM（不是 emit('error')），`spawnDsh` 用 try/catch 统一成返回值，避免调用方炸掉。
14. **工作区外只能读、不能写**：写 `$DSH_HOME` 会被拒，读没问题——所以控制端口信息落盘到运行记录、由 CLI 读回；请求文件通道（写）只服务外部终端。
15. **控制端口的安全边界**：只监听 127.0.0.1、端口由系统分配、每个 launch 一个随机 token、只支持 restart（外加只读的 ping）两个动作、单条消息 64KB 上限；token 落在 `runs/<runId>/run.json`（同用户可读，run 退出即删）。
16. **restart 配置也是对象**：与 `hooks` 一样单独补默认值；类型不对（字符串 / 数组 / null）时回落到完整默认值。
17. **重启默认必须过用户同意**：`restart.requireEscalation=true` 时既不监听控制端口也不落盘 token，逼出一次 `danger-full-access` 批准；「可配置」的意义在于 `false` 能换回免批准的控制端口通道，而不是把安全默认交给默认值以外的代码路径。
18. **请求文件监听器必须持续**：早期实现是「第一次发现请求就自动停止」，在提权模式下（文件是唯一通道）会让第二次重启请求无人接收、DSH 直接挂死——由 e2e 的 `maxPerSession` 场景（需要连续两次文件通道重启）抓出来，现已改为持续轮询、由调用方显式停止。
19. **唤醒消息走 DSH 自己的 web RPC**：`dsh web` 启动时往 stdout 打印带 token 的 URL（`printUrl` 默认 true），父进程只有在那次 spawn 捕获 stdout 才能拿到 token，所以**只在有 `--wake` 时才把 stdout 从 inherit 改成 pipe + 回显**（没有唤醒请求时输出路径完全不变）。投递是 `GET tokenURL` 换 `dsh-auth-*` cookie → `POST /api/session/prompt`，信封必须是 `{type:"client-request", rpcId, method, payload:{args:{request}}}`（少 `type` 或 `args` 会被 gateway/bad-request 退回，没 cookie 是 401）。整条链路依赖 DSH 内幕，所以失败一律降级成日志。
20. **降级是硬要求**：唤醒投递永不抛错、永不阻塞启动——`deliverWake()` 内部重试到超时，返回 `{ok:false}` 时只写 warn；重试定时器 unref，免得把父进程钉住。
21. **重启不重开浏览器窗口**：`--no-open` 是 web profile 专属参数（commander 对未知参数报错），所以只在 `isRestart && noOpen && webProfile && 没显式传过` 时追加；判定依据是 profile 的 `dsh.profile.bundles` 含 `@deepseek-ai/dsh-web-app`。首次启动保持原样，所以第一次仍会打开窗口。

## 已知限制

- 依赖 DSH 的 `--dump-config` 输出格式和启动错误信息格式，DSH 大版本更新可能变化。
- `BUILTIN_BUNDLES` 硬编码白名单仅作为读不到 profile bundles 时的回退；正常路径按 `@deepseek-ai/*` scope 动态判定，DSH 新增自带 bundle 无需更新。
- 自动禁用只处理「能定位到失败插件」的情况；定位不到时提示手动处理。
- 自动禁用跳过 DSH 自带插件（`cordis:*` / `@deepseek-ai/*`），自带插件失败需手动处理（升级 DSH 或检查配置）。
- 启动 hooks 的超时只能放弃等待、无法真正取消，超时的 hook 可能仍在后台运行。
- hooks 与 dsh-safe 同权限运行，只应放入可信脚本。
- 默认提权模式的「必须批准」**不是自己造的开关，而是拿沙箱边界当闸门**：依赖 DSH 拒绝写 `$DSH_HOME`。若会话文件策略本身就是 `danger-full-access`（或工作区恰好覆盖了 DSH_HOME），写入会直接成功、一步到位，闸门就形同虚设——这是配置层面的取舍，不是 bug：要保住人工确认，就别让 agent 跑在 full-access 下。`dsh-safe status` 只能读配置、读不到沙箱策略，所以它显示的是「按配置」而不是「实际会不会被拦」。
- `requireEscalation=false` 时依赖 loopback 控制端口；若网络被禁用，只能从外部终端用请求文件通道。
- `--no-open` 注入只认官方 web bundle（`@deepseek-ai/dsh-web-app`）；自定义/第三方 web bundle 不会被识别，重启可能仍会开窗口。
- **父进程不会热加载**：改完启动器代码后只重启 DSH 没用，必须重新启动 dsh-safe 本身，否则跑的还是内存里的旧代码。
- 唤醒投递依赖 DSH web 的内部细节（stdout 横幅格式、`printUrl`、token→cookie 交换、RPC 信封）。DSH 升级若改动其中任何一环，该功能会失效——设计上已保证它只降级（记 warn），不影响重启本身。
- 运行实例的存活判定基于父进程 pid，pid 复用是已知限制（只用于「这个 dsh-safe 还在不在」的粗判）。
- Windows 重启是强制终止进程树（`taskkill /T /F`），DSH 会话按消息持久化，最多丢正在写的一条；DSH 沙箱内 taskkill/TerminateProcess 会被拒，但 dsh-safe 运行在沙箱外，不受影响。

## 测试

```bash
# 单元测试（纯函数 / loopback / 真实子进程，无需 dsh）
node test/core.test.js
node test/hooks.test.js
node test/restart.test.js
node test/wake.test.js

# 集成测试（需要真实 dsh，会 spawn 子进程捕获输出）
node test/integration.test.js
node test/launch.test.js
node test/safe.test.js
node test/restart-e2e.test.js   # 假 dsh 验证重启链路（控制端口 / 请求文件 / --wake 唤醒 / 降级）
```

注意：集成测试用 `spawn` 的 `stdio: 'pipe'` 捕获子进程输出，在 DSH 的 workspace-write 沙箱下会 EPERM（命名管道被禁），需要 danger-full-access 权限跑。用户真实环境无此限制。`test/restart.test.js` 里的真实终止用例在沙箱内会自动跳过（taskkill 被拒）。

## 安装与移动

```bash
# 方式一：零安装，直接用 node 跑
node <dsh-safe 目录>/bin/dsh-safe.js <profile>

# 方式二：npm link（推荐，改代码立即生效）
cd <dsh-safe 目录> && npm link
dsh-safe <profile>

# 方式三：全局安装独立副本
npm install -g <dsh-safe 目录>
```

**项目移动后**：方式二需在新位置重新 `npm link` 一次（旧快捷方式指向旧路径会失效）；方式三需重新 `npm install -g <新路径>`。
