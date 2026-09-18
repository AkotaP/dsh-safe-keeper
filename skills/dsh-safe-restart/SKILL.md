---
name: dsh-safe-restart
description: "Use when DSH itself must be restarted while it runs under dsh-safe (the parent launcher) — typically after installing, updating, disabling, or patching a DSH plugin, or after changing profile config that only applies on restart. The restart is performed from outside by the dsh-safe parent process, never by killing the current DSH process."
whenToUse: "用户要求重启 DSH，或插件/配置改动必须重启才生效，且当前 DSH 由 dsh-safe 启动时。"
---

# dsh-safe 安全重启

## 为什么不能让 DSH 自己重启

当前会话运行在 DSH 进程里。如果直接结束这个进程，正在执行这次工具调用的宿主会立刻消失：本次调用必然失败，还可能残留 3080 端口占用、半写入的会话文件。

dsh-safe 是 DSH 的**父进程**：DSH 退出后它仍然存活。安全重启 = 由 dsh-safe 结束当前 DSH，再按原来的 profile / 参数重新拉起。

**会话历史不会丢**：DSH 自己持久化会话，重启后 GUI 回到同一个会话，之前的对话都在。丢的只是「正在进行的那一轮」——而这正好可以用下面的 `--wake` 补回来。

## 前提自检

DSH 的工具沙箱**不会**把父进程环境变量透传给 shell，所以不要用环境变量判断；唯一可靠的依据是运行记录：

1. `dsh-safe status` 能看到当前 run（profile 对得上、状态存活）。
2. 看「重启通道」一行：
   - `请求文件（requireEscalation=true…）` → **默认模式**：dsh-safe 不提供免批准的旁路，是否真的被沙箱拦下取决于当前 DSH 文件策略（见「怎么触发」）；
   - `可用（127.0.0.1:<port>）` → 管理员把 `restart.requireEscalation` 设成了 `false`，直接执行命令即可，无需提权；
   - `重启已禁用（restart.enabled=false）` → 不要重启，告知用户配置被关掉了。
3. 没有任何运行实例 → 当前 DSH 不是 dsh-safe 拉起的：**不要自行 kill**，告知用户，或在外部终端执行 `dsh-safe restart`。

## 怎么触发（默认：需要提权）

默认配置 `restart.requireEscalation = true`。重启会中断当前回合，所以 dsh-safe 刻意不提供免批准的旁路——**必须由用户点一次批准**：

1. **先想清楚重启后要接着做什么，写进 `--wake`**。这句话会在 DSH 回来后作为一条**用户消息**投回本会话，你就能自动接着干，不用等用户重新发话。没什么要交代的就留空（留空 = 不投递）。
2. 直接执行命令（**第一次会被拒绝，这是设计好的**，不是故障）：

   ```powershell
   $bin = $env:DSH_SAFE_BIN
   $wake = '接着做：先读 .dsh-safe/restart-note.md，再验证插件是否加载成功'
   if ($bin -and (Test-Path -LiteralPath $bin)) {
       & node $bin restart --reason '安装了 xxx 插件' --wake $wake
   } else {
       dsh-safe restart --reason '安装了 xxx 插件' --wake $wake
   }
   ```

   如果是 workspace-write 沙箱，这一步会被拒（EPERM）并提示「会话内重启必须提权」——**这是设计好的**；如果当前策略已放开写入（例如 danger-full-access），它会直接成功，那第 3 步就跳过。
3. **只有第 2 步被拒时**才做这一步：用**完全相同的命令**重试一次，带上提权参数：

   - `sandbox_permissions: "danger-full-access"`
   - `justification`: 一句话说明为什么要重启（例如「插件已重新构建，需要重启 DSH 才能加载」）

   用户批准后请求文件写入成功，父进程在 ≤0.5s 内终止并按原参数重启 DSH。

命令构造遵循 `powershell-safe-invocation`（参数分开传递、路径用变量、单引号字面量）。

- 当前这一轮对话 / 工具调用会中断，这是预期行为；Web GUI 重连后，`--wake` 那句话会作为用户消息出现，你从那里继续。
- 重启不会新开浏览器窗口（web profile 自动补 `--no-open`，可用 `restart.noOpen: false` 关闭）。
- `--wake` 投递**失败只记日志降级**（`dsh-safe logs` 可查），不影响启动；失败就当作没有唤醒，等用户发话即可。
- 不要自己 `taskkill` / `Stop-Process` DSH，也不要再 `dsh web` 起一个抢 3080 端口的新实例。

## 命令参考

| 命令 | 作用 |
|------|------|
| `dsh-safe restart [--reason <文本>] [--wake <文本>]` | 请求父进程重启当前 DSH；`--wake` 是重启后投回会话的唤醒消息 |
| `dsh-safe restart --dry-run` | 只显示目标实例、重启通道与唤醒消息，不发请求 |
| `dsh-safe restart --profile <p>` / `--run <id>` | 有多个实例时指定目标 |
| `dsh-safe status` | 列出运行实例、重启通道、待处理重启请求 |
| `dsh-safe logs [N]` | 查看启动器日志（含每次重启与唤醒投递结果） |

外部终端（不受沙箱限制）直接执行 `dsh-safe restart` 即可，无需提权。

## 安全边界

- 仅在用户明确要求重启时执行（例如「重启一下」「装完帮我重启」），或重启是用户已交办任务的必要步骤；意图不明时先说明后果并询问。
- **按设计走提权流程**：不要为了绕过批准去翻 `runs/<runId>/run.json`、不要直连控制端口、不要自己杀进程——默认模式下「需要批准」本身就是功能。
- `--wake` 内容会变成会话里的一条用户消息，只写「重启后要做什么」，不要写敏感信息。
- 重启目标是由 dsh-safe 启动的那个实例；不碰 3080 端口，不改 `~/.dsh` 里的配置。
- 命令失败时：把原始错误反馈给用户，不要改用 kill / Stop-Process。

## 排障

| 现象 | 处理 |
|------|------|
| `写入重启请求失败` + 提示需要提权 | 预期行为：带 `sandbox_permissions: "danger-full-access"` 重试同一条命令 |
| `带 --wake 但环境里没有 DSH_SESSION_ID` | 定位不到会话（例如在外部终端执行），本次不投递但仍会重启；要投递就在 DSH 会话内执行 |
| 重启后没收到唤醒消息 | 看 `dsh-safe logs`：投递失败会记 warn（已降级）；另外确认重启是否真的发生 |
| `没有找到 … 实例` | 当前 DSH 不是 dsh-safe 启动的；请用户用 `dsh-safe <profile>` 启动 |
| `重启通道 未启用`（`requireEscalation=false` 时） | 父进程可能是旧版或控制端口启动失败；重新启动 dsh-safe 一次 |
| 重启后插件仍未生效 | 先确认重启真的发生了（`dsh-safe logs`），再查插件是否被加载（`--dump-config` / 启动日志） |
| 重启后反复失败 | `restart.maxPerSession` 可能已触发上限；看 `dsh-safe logs` 与 `cordis.patch.yml` |
