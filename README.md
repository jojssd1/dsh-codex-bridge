# dsh-codex-bridge

把 **DeepSeek Harness (DSH)** 变成 **Codex 的子代理**——通过 MCP 暴露。

Codex 负责编排、物理判断与验收；DSH 负责受限执行。每个 subagent 持有自己的会话上下文，可以连续多轮对话，而不是一次一个孤立任务。

---

## 1 · 为什么需要它

直接用命令行调 DSH 有三个问题：

| 问题 | 本项目的解法 |
|---|---|
| 每次调用都是**无状态**的，没有上下文 | **一个会话 = 一个有记忆的 subagent**，可续聊 |
| 看不到**实时进度**，长任务就是黑盒 | 事件流 + Web 看板 + SSE |
| 长任务会撞上调用方的超时 | 超时**只停止等待，不杀任务**（见 §6.1） |

---

## 2 · 架构

```
                    ┌──────────────────────────────┐
   Codex ── MCP ────┤  dsh-mcp-server.mjs (MCP)    │
  (编排方)  stdio   │  每个对话一个进程             │
                    └───────────┬──────────────────┘
                                │ spawn
                                ▼
                    ┌──────────────────────────────┐
                    │  DeepSeek Harness (headless)  │
                    │  --profile headless --json    │
                    └───────────┬──────────────────┘
                                │ NDJSON 事件流
                                │
                    ┌───────────▼──────────────────┐
                    │   Hub (detached 常驻进程)     │
                    │   独占 127.0.0.1:8799         │
                    └───────────┬──────────────────┘
                                │ SSE
                                ▼
                          Web 看板 (dashboard.html)
```

### 三个角色

**MCP server** — Codex 的 stdio 对端。每个 Codex 对话会拉起**一个独立进程**。它负责发起 run、解析 DSH 的 NDJSON、把事件**转发**给 hub。

**Hub** — 一个 detached 常驻进程，**独占看板端口**。所有 MCP server 通过 `POST /api/ingest` 把事件推给它。

> 为什么需要 hub？因为 Codex **每个对话起一个 MCP server**。如果每个 server 都去抢 8799，只有第一个会成功，其余的看板会**静默失效**。Hub 把"谁持有端口"变成"谁先赢得竞态"，且心搏自愈。

**看板** — 单文件 HTML，从磁盘按请求读取（`no-store`），所以**改页面只需刷新**，不用重启任何东西。

---

## 3 · 一次任务的完整生命周期

```
1. Codex 调 dsh_send / dsh_start
2. MCP server spawn 一个 DSH 进程
      dsh --profile headless --json "<task>"
3. DSH 输出 NDJSON 事件（见下）
4. 事件同时：写日志 runs/<run>.jsonl、更新内存块、250ms 批量转发给 hub
5. Hub 折成 blocks，经 SSE 推给看板
6. run 结束 → hub 收到终态 → 看板更新
```

### DSH 的事件类型

```
session     {sessionId, cwd}          <- 用于续聊的关键
status      {phase, turn, step, usage}
thinking    {text}
text        {text}
tool_call   {callId, tool, input}
tool_result {callId, status, result}
error       {message}
final       {text}
```

**重要**：这是**提交点**投影，不是 token 级流。源码注释说明 text/reasoning 来自已提交的 `assistant/message`，**不来自仍在流式的尝试**。所以它是"一段一段来"的，不是逐字。

---

## 4 · 安装

### 4.1 注册到 Codex

`~/.codex/config.toml`：

```
[mcp_servers.dsh]
command = "C:\\path\\to\\node.exe"
args = ["C:\\path\\to\\dsh-mcp-server.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600

[mcp_servers.dsh.env]
DSH_DASHBOARD_PORT = "8799"
DSH_MCP_TIMEOUT_MS = "1800000"      # 30 分钟；超时只停止等待，不杀任务
```

### 4.2 让 headless profile 有模型

headless profile 默认**不带任何 LLM provider**，需要在自己的 patch 层里镜像一个：

`~/.dsh/profiles/headless/cordis.patch.yml`

```
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      <your-provider>:
        models:
          - id: <model-id>
            contextWindow: 1000000
            maxTokens: 384000
            reasoningEfforts: { off: null, high: high, max: max }
        apiKeyEnv: <YOUR_API_KEY_ENV>
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: <your-provider>
    model: <model-id>
    reasoningEffort: high
```

**这一层每轮都重新读取**——改完下一个任务就生效，**不需要重启**。

验证：

```
dsh --profile headless --dump-config | grep reasoningEffort
```

### 4.3 跑测试

```
node verify-all.mjs        # MCP 协议 / 工具 / 错误路径 / 两轮上下文
node test-hub-multi.mjs    # 3 个 server 共用一个看板；hub 被杀后自愈
```

---

## 5 · 工具

| 工具 | 用途 |
|---|---|
| `dsh_run` | 派一个任务并等最终答案 |
| `dsh_send` | **往已有会话发一条消息**（保留上下文） |
| `dsh_start` | 点火即返回（长任务首选） |
| `dsh_status` | 查进度 |
| `dsh_result` | 取结果 |
| `dsh_cancel` | 取消 |
| `dsh_conversations` | 列出所有会话 |
| `dsh_forget` | 销毁会话（可选连同 DSH session 目录一起清） |

### 单写者约束

**DSH 一个会话只允许一个写者。** 对一个正在跑的会话再发消息会被拒绝——这不是桥的限制，是 DSH 自身的锁。

桥在发起前检查，并给出可操作的提示：

```
subagent <id> is still working (run <run>, 1121s in).
DSH allows only one writer per session, so a new message cannot attach to a running turn.

  STOP it:     dsh_cancel <run>
               Kills only the in-flight turn. Files the tools already wrote stay on disk.
  COLLECT it:  dsh_status <run> / dsh_result <run>
  JUST WAIT:   dsh_status <run> with wait_ms
```

**`dsh_cancel` 不会毁掉已完成的工作**——工具写下的文件已经落盘，日志保留到那一刻。只有正在飞的那一轮会丢。

---

## 6 · 踩过的坑（最有价值的部分）

这些都是**实际造成过损失**的问题，不是理论风险。

### 6.1 超时不该杀任务

最初超时直接 `child.kill()`。结果：一个合法的长回归跑了 **1200 秒**被杀死，**工作全丢**，调用方收到 `failed`。

```
日志证据：
{"type":"bridge_exit","code":null,"signal":"SIGTERM","timedOut":true,"killed":true}
时长 1200s = 正好 20 分钟
```

**修正**：超时只**脱开等待**，不杀进程。

```
const timer = setTimeout(() => {
  state.timedOut = true;
  state.detached = true;
  for (const w of state.listeners.splice(0)) w(state);   // 唤醒调用方
}, timeout_ms);                                          // 没有 kill
```

调用方改为收到：

```
Still running after 1200s -- it was NOT killed.
run_id: run-3-xxxx
Collect it later with dsh_status / dsh_result, or dsh_cancel to stop it.
```

并且 `finish(code === 0 ? "done" : "failed")`——**不再因为"我们停止等待了"把成功写成失败**。

### 6.2 `stream.end()` 的位置吞掉了所有诊断

为了诊断长任务为什么死，写了 `bridge_exit` 记录——但 **35 份日志里一条都没有**。

原因：

```
const finish = (status) => {
  stream.end();                    // <- 流在这里就关了
  ...
  try { stream.write(bridge_exit); } catch {}   // <- 写不进去，异常被空 catch 吞掉
};
```

**往 `end()` 之后的流写数据是无效的**，而 `catch {}` 掩盖了它。

修正：把 `stream.end()` 移到所有收尾写入**之后**。

> 教训：**空的 catch 块会让你的诊断代码静默失效**。花了好几轮才找到。

### 6.3 每个 Codex 对话一个 MCP server → 端口争抢

Codex 为**每个对话**拉起一个 MCP server 进程。三个对话 = 三个进程抢 8799，只有第一个成功，其余静默失去看板。

解法是 hub + 转发 + 5 秒心搏自愈。已验证：hub 被杀后 **1 秒**重建。

### 6.4 detached 进程启动即死

Hub 用 `detached: true, stdio: "ignore"` 起，结果秒退。原因：代码里有

```
process.stdin.on("end", () => process.exit(0));
```

而 detached 进程的 stdin 是 `/dev/null`，**立刻 EOF**。修正：把 stdin 处理用 `if (!HUB_MODE)` 包起来。

### 6.5 完成的任务在看板上卡在 running

`finish()` 在事件缓冲区**已经排空之后**才调 `flushForward()`，那个终态从未发出。

修正：加一条独立的 `forwardStatus()`，确保终态一定推得出去。

### 6.6 跨目录 resume 被拒

`session "<x>" was recorded in "<dirA>", not "<dirB>"`——DSH 拒绝跨目录续聊。桥用 `process.cwd()`，与 DSH 记录的不符。

修正：`cwdForSession()` 扫描 `runs/*.jsonl` 找出该会话原本的目录。

### 6.7 重复气泡

`text` 和 `final` 携带同一段文字，界面显示两遍。修正：检测末尾内容相同则把 `msg` 重标为 `final`。

### 6.8 失败被重新加载洗成成功

Hub 重启后 `rehydrate()` 把**所有**会话标成 `done`——**把中断洗成了成功**。

修正：只有日志里**确实有 `final` 事件**才算完成，否则是 `interrupted`。

### 6.9 静默的实例 = 死掉的任务

一个 MCP server 是它启动的 DSH 进程的父进程。Codex 关闭该对话时，**进程树一起被杀**，run 中途停止且**没有任何 error 事件**。

Hub 现在记录每个 run 的归属实例，并有一个哨兵：某实例超过阈值没有转发任何东西 → 把它名下的 run 标成 `interrupted`，并附上说明。

### 6.10 引入主题变量要做全量颜色审计

把界面改成明暗双主题时，只替换了"看得见的那几处"，漏掉了工具行的输入输出区域（写死的 `#0a0c10`）和写死的白色粗体（浅色下隐形）。用户直接反馈看不清。

**教训**：写脚本扫描所有仍然硬编码的颜色，算相对亮度，低于阈值的就是浅色模式下的问题点。一次扫出 10 处。

---

## 7 · 已知限制

1. **MCP server 被杀会带走正在跑的 run**。因为 run 是 MCP server 的子进程。彻底修法是把 run 改成 detached 并自己写日志，尚未实现。
2. **`approval: "ask"` 在无头运行里无人应答**，可能造成另一种卡住。
3. **事件流是提交点投影，不是 token 级**。想要真正的逐字流式，需要在 DSH 内订阅 `session/event`。
4. **Hub 有 30 分钟空闲退出**。没有 MCP server 时会自退——而那恰恰是最需要看板的时候。

---

## 8 · 文件

```
dsh-mcp-server.mjs    MCP server + hub（双角色，--hub 切换）
dashboard.html        看板（单文件，按请求从磁盘读）
verify-all.mjs        MCP 协议与工具的综合验证
test-hub-multi.mjs    多 server 共享 hub 与自愈验证
```

---

## License

MIT
