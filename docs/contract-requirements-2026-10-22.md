# DSH 执行契约升级需求

版本：2026-10-22

用途：提交给 DSH 桌面版，用于更新 dsh-execution-contract skill 和相关执行约束。

## 目标

DSH 负责执行已经由上游确定的批量仿真、候选冻结、真实求解和轻量后处理。Codex 负责物理判断、任务拆解、候选选择和最终验收。

本次升级重点解决：

- DSH 把项目 cwd、工程根目录和阶段目录混淆；
- 为寻找文件递归扫描整个工程；
- 一个任务同时承担方案理解、基线选择、runner 改造、求解和后处理；
- 任务中断后无法区分已完成、正在运行和未开始阶段；
- 缺少基线时继续猜测或使用旧低保真结果；
- 自检失败后反复修改脚本；
- 长时间阻塞等待；
- 代理结果、真实求解结果和数值审计结果混在一起。

## 一、绝对路径优先

任务文本中出现的路径必须视为唯一来源。所有读写命令都使用绝对路径。

DSH 禁止：

- 通过递归搜索整个项目来猜测输入文件；
- 把 workspace 根目录当成项目 cwd；
- 把上一轮任务目录当成当前任务目录；
- 从 cwd 推断阶段目录；
- 因为相对路径不存在而自行扩大搜索范围。

如果任务指定文件不存在，立即返回：

BLOCKED_MISSING_INPUT
path=<绝对路径>
next_action=<需要上游提供的具体文件>

不得自行寻找替代文件。

## 二、四阶段执行模式

每个任务严格分成四个阶段：

1. PREFLIGHT
2. SOLVE
3. POSTPROCESS
4. FINAL

不要把四个阶段合并成长回合。

### PREFLIGHT

只检查：

- 输入文件存在；
- 输出目录可写；
- frozen 参数能读取；
- runner 可以导入；
- solver、材料卡、蒸发卡哈希一致；
- 工况、网格、时间步、AMR 和 backend 一致。

限制：

- 最多 3 次读取或命令调用；
- 不递归搜索；
- 不读取 NPZ、VTK、PNG、完整训练集或历史目录；
- 不做物理推导；
- 不运行 solver；
- 30 秒内写出 selfcheck_<phase>.json。

预检失败立即停止。

### SOLVE

- 只调用任务指定 runner；
- 每个工况独立子进程和独立输出目录；
- GPU 并行度由任务明确指定，未指定时默认 1；
- 不重复运行已有成功样本；
- 每个样本完成时写出轻量 metrics_fast.json 和 progress.json；
- 只返回进度、真实退出码和输出路径。

### POSTPROCESS

只有所有目标样本完成后才进入后处理。

只读取当前批次的 metrics_fast.json、progress.json、summary_86.json、audit 文件和任务明确授权的固定轮廓提取脚本。

禁止：

- 重新扫描整个项目；
- 从历史阶段寻找后处理脚本；
- 从 NPZ 或 VTK 重新推导已经存在的轻量指标；
- 把代理预测写入真实求解字段；
- 生成超过 80 行的报告。

### FINAL

输出以下内容后停止：

- 成功和失败样本；
- 真实退出码；
- W、D、RMS、Tmax；
- 最大步残差、能量闭合、AMR、身份和形态状态；
- 参数回读；
- 是否通过验收；
- 阻塞项；
- 文件路径。

不要自动启动下一轮任务。

## 三、基线解析规则

基线必须由上游给出绝对路径或明确白名单目录。

如果同一个工况有多个基线：

1. 优先选择完全相同的 fidelity_id；
2. 比较 solver、material、evaporation 哈希；
3. 比较网格、时间步、AMR 窗口和 backend；
4. 仍有多个时，停止并返回 BLOCKED_BASELINE_AMBIGUOUS。

禁止：

- 使用旧低保真基线替代同保真基线；
- 使用 proxy-only baseline 作为真实比较基线；
- 使用历史候选参数代替 frozen 参数；
- 以文件名相似作为唯一依据。

## 四、困难任务必须分阶段

如果任务同时包含以下两项或以上：

- 基线选择；
- 新源项或新参数实现；
- runner 改造；
- 多工况求解；
- 后处理；
- 物理解释；

必须拆成多个 DSH 任务或多个独立阶段。

推荐拆分：

Task A：只做输入冻结和 preflight。
Task B：只运行已冻结的真实求解。
Task C：只做轻量后处理。
Task D：只做结果汇总。

不要在一个回合里同时探索、改代码、跑求解、解释失败和规划下一轮。

## 五、失败和阻塞规则

缺少输入时返回 BLOCKED_MISSING_INPUT。

基线不一致时返回 BLOCKED_BASELINE_MISMATCH。

物理源构造不允许参数时返回 BLOCKED_SOURCE_CONTRACT。

例如：

- source 构造函数要求 kappa 大于等于零时，不得传入负 kappa；
- 不得通过修改冻结 source 文件绕过约束；
- 不得把奇异参数当作真实求解候选。

Solver 数值失败时保留 traceback、真实退出码、失败样本、已完成样本和 partial output。

只允许一次明确的机械重试，例如 CUDA 上下文地址错误、单纯进程启动失败或临时目录冲突。机械重试必须记录原因。

不得因为数值失败自动放宽验收门槛或修改物理参数。

自检失败最多修复一次。第二次失败后直接返回错误字段和文件路径，不得继续循环。

## 六、等待和轮询规则

禁止：

- Start-Sleep 或 sleep 作为状态监控；
- job_output wait=true 且 timeout_ms 大于 60000；
- 在 DSH 内部长时间阻塞等待。

允许：

- job_output wait=false；
- job_output wait=true 且 timeout_ms 不超过 15000；
- 读取一个指定的 progress.json；
- 将长任务状态交回桥层，由上游调用 dsh_status。

## 七、推理等级规则

- off：机械执行、已有 runner、固定后处理；
- low：少量脚本适配；
- medium：已有方案但有多个输入来源；
- high：物理方案评审或故障机制分析。

high 也必须遵守短回合规则，不得以高思考为理由长时间扫描或重复自检。

高难任务的 prompt 必须写明：

只保留必要分析。
不要重复读取同一文件。
不要递归扫描。
不要生成长计划。
最多一次自检。
遇到缺失输入立即 BLOCKED。

## 八、真实结果和代理结果隔离

输出字段必须区分：

- true_solver
- forward_gpr
- path_candidate
- numerical_audit

禁止把 GPR 预测、线性 Jacobian 估计或共享路径插值写入 W_solver_um、D_solver_um 或真实求解结果字段。

只有真实 solver 输出并通过独立数值审计，才能标记 true_solver_numerically_normal=true。

只有真实 W、D、RMS 和数值审计共同通过，才能标记 promoted_pass=true。

## 九、输出契约

批量真实求解任务至少输出：

- design_<phase>.json
- frozen_batch_<phase>.json
- run_<phase>.py
- exit_codes_<phase>.json
- selfcheck_<phase>.json
- assessment_<phase>.json
- findings_<phase>.md
- 每个样本的 summary_86.json
- 每个样本的 progress.json
- 每个样本的 metrics_fast.json
- 每个样本的 audit 文件

离线代理任务至少输出：

- 任务脚本
- report_<phase>.json
- findings_<phase>.md
- predictions_<phase>.csv

## 十、最小返回模板

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

## 十一、验收测试

写入 skill 后，使用以下测试验证：

1. 给出错误相对路径：必须返回 BLOCKED_MISSING_INPUT，不得递归搜索；
2. 给出两个不同 fidelity 的基线：必须返回 BLOCKED_BASELINE_AMBIGUOUS；
3. 给出已冻结 runner 和 3 个工况：必须先写 selfcheck，再运行；
4. 给出长任务：不得使用超过 60 秒的 wait=true；
5. 给出一次 CUDA 机械错误：最多串行重试一次，并保留 partial output。

## 十二、建议安装位置

建议由 DSH 桌面版将本需求转换并合并到：

C:/Users/Admin01/.dsh/skills/dsh-execution-contract/SKILL.md

建议保留本文件作为版本化需求：

DSH执行契约升级需求_绝对路径短回合与困难任务分阶段.md

建议在 skill frontmatter 中增加：

description: Enforce absolute paths, staged execution, short bounded turns, explicit baseline provenance, no recursive discovery, and immediate blocked-state reporting for DSH tasks.
