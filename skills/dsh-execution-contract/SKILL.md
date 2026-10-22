---
name: dsh-execution-contract
description: 约束通过 DSH 桥（dsh_run / dsh_send / dsh_start）派发的受限执行任务——上游已确定物理方案、参数律与 runner，执行方只负责落地、记录和轻量验收。Enforce absolute paths, staged execution (PREFLIGHT/SOLVE/POSTPROCESS/FINAL), short bounded turns, explicit baseline provenance, no recursive discovery, and immediate BLOCKED-state reporting. 当任务文本出现「执行契约」标记，或任务形态是"按已定方案执行批量仿真/固定后处理"时，必须先加载本 skill。Stops scope drift, path guessing, unbounded搜索, and invented metrics.
---

> **触发条件**：任务文本中出现 `[执行契约]` 标记，或任务形态为「上游已定方案 + 受限执行」时，加载本 skill 并严格遵守。
>
> **不适用**：探索性任务（"先看看这个目录有什么""帮我看看这个模型怎么实现的"）。此时不加载，按普通任务处理。

# DSH 执行契约

版本：2026-10-22

## 0. 总则

DSH 负责执行已经由上游确定的批量仿真、候选冻结、真实求解和轻量后处理。
Codex 负责物理判断、任务拆解、候选选择和最终验收。

三条不可协商的原则：

1. **路径唯一来源**：任务文本里给的路径就是唯一路径，不得推断、不得扩大搜索。
2. **阶段隔离**：一个回合只做一件事。理解、改代码、求解、解释失败不得混在一起。
3. **证据可追溯**：真实退出码、真实 JSON、真实残差。缺指标就说缺指标，不编造。

## 1. 绝对路径优先

任务文本中出现的路径必须视为唯一来源。所有读写命令都使用**绝对路径**。

禁止：

- 通过递归搜索整个项目来猜测输入文件；
- 把 workspace 根目录当成项目 cwd；
- 把上一轮任务目录当成当前任务目录；
- 从 cwd 推断阶段目录；
- 因为相对路径不存在而自行扩大搜索范围。

任务指定的文件不存在时，**立即返回**并停止：

```
BLOCKED_MISSING_INPUT
path=<绝对路径>
next_action=<需要上游提供的具体文件>
```

不得寻找替代文件，不得用"相似文件名"顶替。

## 2. 四阶段执行模式

每个任务严格分成四个阶段，完成一个阶段立即返回状态，**不得合并成长回合**：

1. PREFLIGHT  2. SOLVE  3. POSTPROCESS  4. FINAL

### 2.1 PREFLIGHT

只检查：输入文件存在、输出目录可写、frozen 参数能读取、runner 可以导入、solver/材料卡/蒸发卡哈希一致、工况/网格/时间步/AMR/backend 一致。

限制：

- 最多 3 次读取或命令调用；
- 不递归搜索；
- 不读取 NPZ、VTK、PNG、完整训练集或历史目录；
- 不做物理推导，不运行 solver，不写 `todo_write`，不做方案比较；
- 30 秒内写出 `selfcheck_<phase>.json` 并返回。

**预检失败立即停止。** 不得擅自修改物理公式或输入文件。

### 2.2 SOLVE

- 只调用任务指定的 runner，不重新实现求解器，不搜索替代 runner；
- 每个工况独立子进程、独立输出目录；已完成工况不得重跑；
- 并行度由任务明确指定；未指定时 GPU 默认 `MAX_WORKERS=1`；CPU 粗扫只有上游批准才并行；
- 禁止读取历史结果目录，禁止求解完成后重新遍历大文件；
- 每个样本完成时写出 `metrics_fast.json`，至少含：

  `case_id, status, W_um, D_um, RMS_um, Tmax_K, energy_residual_max, backend, steps, parameters, solver_exit_code, wall_s`

- 只返回进度、真实退出码和输出路径；不生成长报告。

### 2.3 POSTPROCESS

**只有所有目标样本完成后才进入后处理。**

只读取当前批次的 `metrics_fast.json`、`progress.json`、`summary_86.json`、audit 文件和任务明确授权的固定轮廓提取脚本。

禁止：

- 重新扫描整个项目；
- 从历史阶段寻找后处理脚本；
- 从 NPZ 或 VTK 重新推导已经存在的轻量指标；
- 把代理预测写入真实求解字段；
- 生成超过 80 行的报告。

### 2.4 FINAL

输出以下内容后**停止**：

- 成功和失败样本；真实退出码；
- W、D、RMS、Tmax；
- 最大步残差、能量闭合、AMR、身份和形态状态；
- 参数回读；是否通过验收；阻塞项；文件绝对路径。

**不要自动启动下一轮任务。** 不训练 GPR/BO，不扩大工况范围。

## 3. 读取与写入边界

- 只能访问任务白名单和指定输出目录；不得读取凭据、用户目录或整个工程；
- 同一批文件只允许一个执行者写入；发现已有用户修改、活动任务或输出目录冲突，立即报告并停止；
- 不修改 `clean_solver.py`、材料卡、蒸发卡、历史结果和训练集，除非上游明确列入允许写入清单；
- 不能把"文件存在"或"模型自称完成"当作验收；必须检查实际 JSON、真实退出码、步数、后端和能量残差。

## 4. 基线解析规则

基线必须由上游给出**绝对路径或明确白名单目录**。

同一工况有多个基线时，按顺序判定：

1. 优先选择完全相同的 `fidelity_id`；
2. 比较 solver、material、evaporation 哈希；
3. 比较网格、时间步、AMR 窗口和 backend；
4. 仍有多个 → 停止并返回 `BLOCKED_BASELINE_AMBIGUOUS`。

禁止：

- 用旧低保真基线替代同保真基线；
- 用 proxy-only baseline 作为真实比较基线；
- 用历史候选参数代替 frozen 参数；
- 以文件名相似作为唯一依据。

## 5. 困难任务必须分阶段

任务同时包含以下**两项或以上**时，必须拆成多个 DSH 任务或多个独立阶段：

基线选择 / 新源项或新参数实现 / runner 改造 / 多工况求解 / 后处理 / 物理解释。

推荐拆分：

```
Task A：只做输入冻结和 preflight
Task B：只运行已冻结的真实求解
Task C：只做轻量后处理
Task D：只做结果汇总
```

不要在一个回合里同时探索、改代码、跑求解、解释失败和规划下一轮。

## 6. 失败和阻塞规则

标准阻塞码：

| 情形 | 返回 |
|---|---|
| 缺少输入文件 | `BLOCKED_MISSING_INPUT` |
| 基线不一致/歧义 | `BLOCKED_BASELINE_MISMATCH` / `BLOCKED_BASELINE_AMBIGUOUS` |
| 物理源构造不允许该参数 | `BLOCKED_SOURCE_CONTRACT` |

`BLOCKED_SOURCE_CONTRACT` 示例：source 构造函数要求 `kappa >= 0` 时，不得传入负 kappa；不得通过修改冻结 source 文件绕过约束；不得把奇异参数当作真实求解候选。

Solver 数值失败时**保留** traceback、真实退出码、失败样本、已完成样本和 partial output。

重试规则：

- 只允许**一次**明确的机械重试（CUDA 上下文地址错误、进程启动失败、临时目录冲突），且必须记录原因；
- **不得**因为数值失败自动放宽验收门槛或修改物理参数；
- 自检失败最多修复一次；第二次失败后直接返回错误字段和文件路径，不得继续循环。

## 7. 等待和轮询规则

禁止：

- `Start-Sleep` / `sleep` 作为状态监控；
- `job_output` 带 `wait=true` 且 `timeout_ms > 60000`；
- 在 DSH 内部长时间阻塞等待。

允许：

- `job_output` 且 `wait=false`；
- `job_output` 且 `wait=true`、`timeout_ms <= 15000`；
- 读取一个指定的 `progress.json`；
- 把长任务状态交回桥层，由上游调用 `dsh_status`。

## 8. 推理等级规则

> **重要**：本路由（opencode-go / deepseek-v4.1-flash）**只声明了 `off` / `high` / `max`**。
> 传入 `low` 或 `medium` 会让整个 run 在 provider 侧失败（`UNSUPPORTED_REASONING_EFFORT`），
> 桥现在会在启动前本地拒绝。**不要写 low 或 medium。**

| 等级 | 用于 |
|---|---|
| `off` | 机械执行、已有 runner、固定后处理 |
| `high` | 少量脚本适配、多个输入来源、方案评审 |
| `max` | 物理方案评审或故障机制分析（最高，慎用） |

`high` 和 `max` **也必须遵守短回合规则**，不得以"高思考"为理由长时间扫描或重复自检。

高难任务的 prompt 必须写明：

```
只保留必要分析。
不要重复读取同一文件。
不要递归扫描。
不要生成长计划。
最多一次自检。
遇到缺失输入立即 BLOCKED。
```

## 9. 真实结果与代理结果隔离

输出字段必须区分四类来源：

```
true_solver       真实求解器输出
forward_gpr       代理模型预测
path_candidate    共享路径插值候选
numerical_audit   独立数值审计
```

- **禁止**把 GPR 预测、线性 Jacobian 估计或共享路径插值写入 `W_solver_um`、`D_solver_um` 或任何真实求解结果字段；
- 只有真实 solver 输出并通过独立数值审计，才能标记 `true_solver_numerically_normal=true`；
- 只有真实 W、D、RMS 和数值审计**共同通过**，才能标记 `promoted_pass=true`。

## 10. 输出契约

**批量真实求解任务**至少输出：

```
design_<phase>.json          frozen_batch_<phase>.json
run_<phase>.py               exit_codes_<phase>.json
selfcheck_<phase>.json       assessment_<phase>.json
findings_<phase>.md
每个样本：summary_86.json / progress.json / metrics_fast.json / audit 文件
```

**离线代理任务**至少输出：任务脚本、`report_<phase>.json`、`findings_<phase>.md`、`predictions_<phase>.csv`。

## 11. 最小返回模板

```
status: COMPLETED | BLOCKED | FAILED
phase: <phase>
solver_runs: <整数>
parallelism: <整数>
exit_codes: <简表>
promoted_pass_count: <整数>/<总数>
blocked_points: <列表>
failed_points: <列表>
outputs: <绝对路径列表>
next_action: <一句话>
```

禁止返回与任务无关的长篇推理、历史目录清单或重复的物理背景。

## 12. 会话复用

- 同一物理方案的续跑优先复用同一 session；物理方案或输出目录改变时新建 session，避免旧上下文膨胀；
- session 只保存执行上下文，不代表跨重启永久保留；每次任务仍必须给出完整白名单和停止条件。

## 13. 自检清单（返回前逐条核对）

- [ ] 所有路径都是绝对路径，且来自任务文本？
- [ ] 这一轮只做了一个阶段？（PREFLIGHT / SOLVE / POSTPROCESS / FINAL）
- [ ] 没有递归搜索、没有读取 NPZ/VTK/PNG/历史目录？
- [ ] 等待没有超过 60000ms，也没有用 sleep 当监控？
- [ ] 推理等级用的是 off / high / max（不是 low / medium）？
- [ ] 失败时保留了 traceback 和真实退出码？
- [ ] 代理预测没有写进真实求解字段？
- [ ] 缺指标时报告了"指标未提取"，而不是编造？
