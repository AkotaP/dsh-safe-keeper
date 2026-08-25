# dsh-safe-keeper

DSH（DeepSeek Harness）的启动器：作为 DSH 的父进程，在 DSH 因插件启动失败而退出后，自动定位失败插件、写禁用、重启。另提供安全模式、日志、配置。

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
│   ├── dsh.js            # spawn dsh、解析 --dump-config、从 stderr 提取失败插件
│   ├── patch.js          # 读写 cordis.patch.yml（含空数组 [] 处理）
│   ├── config.js         # 配置读写（config.json）
│   ├── logger.js         # 日志（文件 + 保留上限截断）
│   ├── state.js          # 状态（记录自动禁用的插件）
│   └── paths.js          # 路径解析（DSH_HOME / profile 目录 / dsh-safe 目录）
├── test/
│   ├── core.test.js      # 单元测试（纯函数）
│   ├── integration.test.js  # spawnDsh + getPluginMap 集成测试
│   ├── launch.test.js    # 完整 launch 链路集成测试
│   └── safe.test.js      # 安全模式集成测试
└── README.md
```

零依赖：只用 Node 内置模块（`node:fs` / `node:child_process` / `node:path` / `node:os`）。

## 工作原理

### 启动流程（launch）

```
dsh-safe <profile> [args...]
  └─ spawn dsh --profile <profile> <args>   （捕获 stderr + 退出码）
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

### 安全模式（--safe）

`dsh-safe --safe <profile>` 只禁用**第三方插件**，保留 DSH 自带的 bundle。

- 第三方识别：`--dump-config` 的 `# == <bundle名>` 来源注释，来源不在 `BUILTIN_BUNDLES` 白名单里的就是第三方。
- `BUILTIN_BUNDLES` 硬编码：`@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` / `@deepseek-ai/dsh-headless`。
- 实现：把禁用条目写进**临时文件** `$DSH_HOME/dsh-safe/safe-mode.patch.yml`，用 `dsh --patch <临时文件>` 启动。**不修改 cordis.patch.yml**，所以安全模式是临时的、一次性的，下次正常启动原配置原样生效。

## 关键设计决策与坑

1. **patch 层语义**：cordis.patch.yml 里「新增插件」必须用 `insert`，直接写 `- id: xxx` 会被当成「覆盖已有条目」而报 `entry not found`。但「禁用已有插件」用 `- id: xxx / disabled: true`（覆盖 disabled 字段）是对的，因为被禁用的插件本来就在 bundle 层。
2. **Windows spawn**：npm 的 bin 是 `.cmd` shim，`spawn("dsh", args, {shell: true})` 才能跑（与 DSH 自己 `dsh plugin` 里 spawn pnpm 的方式一致）。会触发 Node 的 DEP0190 弃用警告，可接受（args 是用户自己传的，无注入风险）。
3. **中断处理**：launch 里监听 SIGINT/SIGTERM，用户 Ctrl+C 时不再自动重启（否则退出码 130 会被误判为启动失败）。
4. **重试上限**：`retryLimit` 防止「禁用没生效 → 重启又失败 → 又禁用」死循环。
5. **DSH_HOME 解析**：与 DSH 一致，`$DSH_HOME` 环境变量优先，否则 `~/.dsh`。

## 已知限制

- 依赖 DSH 的 `--dump-config` 输出格式和启动错误信息格式，DSH 大版本更新可能变化。
- `BUILTIN_BUNDLES` 是硬编码白名单，DSH 新增自带 bundle 时需手动更新。
- 自动禁用只处理「能定位到失败插件」的情况；定位不到时提示手动处理。

## 测试

```bash
# 单元测试（纯函数，无需 dsh）
node test/core.test.js

# 集成测试（需要真实 dsh，会 spawn 子进程捕获输出）
node test/integration.test.js
node test/launch.test.js
node test/safe.test.js
```

注意：集成测试用 `spawn` 的 `stdio: 'pipe'` 捕获子进程输出，在 DSH 的 workspace-write 沙箱下会 EPERM（命名管道被禁），需要 danger-full-access 权限跑。用户真实环境无此限制。

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
