# @dsh-my-plugin/context-guardian（上下文守护者）

针对每个会话的上下文做**价值感知的自动压缩与剪枝**：保留有用信息，清理污染，
避免上下文过长或被污染。v1.1 对齐官方方案（`@deepseek-ai/dsh-compaction-basic`、
`dsh-compaction-tool-result-pruner`）的触发时机与替换协议。

## 功能

- **三层时机（对齐官方 compaction-basic）**：
  1. `agent/pre-step` —— 模型请求**前**做零成本剪枝/污染清理（提前干预，不阻塞管线）；
  2. `agent/request-error` —— context-overflow 失败时强制剪枝+压缩并请求重试；
  3. `session/event` 去抖巡检 —— 压力高的会话做完整 清理→剪枝→压缩 分级处置；
- **压力观测**：用平台 `tokenMeter` 持续测量每个会话的总 token 压力，分级为
  `watch → prune → compact → critical`；
- **价值感知压缩**：扫描表面节点，识别高价值信息（用户指令、关键词命中、最近
  对话、已有摘要）并保护；对低价值区间调用平台 `compaction.compactRegion` 定点
  压缩成摘要——近期对话与关键指令**永不**进入压缩范围；
- **保留策略（对齐官方）**：压缩区间主策略按尾部 `retainTokens` 预算逐字保留，
  再回退到工具配对平衡切点（`toolPairingBalancedBefore`），永远不劈开
  tool-call/result 配对；
- **价值剪枝**：对超长工具结果做头/尾保留剪枝（保留 40% 预算的头部与尾部关键
  信息，中间截断并标记），按 Unicode 码点切片（不劈开 emoji/生僻字），模型无关、零成本；
- **污染清理**：识别连续失败堆积（仅保留最后一次）、重复行噪音等，替换为极简
  占位，防止上下文被污染；
- **替换协议（对齐官方 pruner）**：工具结果用 `tool/result` 事件替换（保留 callId
  配对语义），每次替换前发出 `compaction/prune` 影子价格事件，token 计量正确扣减；
- **异常隔离（仓库第一原则）**：协作者模式——不覆盖任何平台服务，所有平台调用
  与事件监听都在各自 try/catch 内，插件失败只记日志，绝不影响 DSH 本体。

## 工作原理

```
agent/pre-step ──► 零成本剪枝/清理（请求前，不阻塞）
agent/request-error ──► overflow：强制剪枝+压缩 → {kind:'retry'}
session/event ──► 去抖巡检（15s/会话）→ 清理 → 剪枝 → 定点压缩
```

## 安装

```bash
# 开发期：本地链接
dsh plugin --profile web add link:<本仓库绝对路径>/packages/context-guardian

# 发布后
dsh plugin --profile web add @dsh-my-plugin/context-guardian
```

## 配置（schemastery，全部有默认值，无配置即可加载）

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `watchTokens` | `120000` | 进入观察级 |
| `pruneTokens` | `160000` | 触发价值剪枝 |
| `compactTokens` | `200000` | 触发低价值区间压缩 |
| `criticalTokens` | `240000` | 紧急级 |
| `toolResultCharLimit` | `4000` | 单工具结果字符上限 |
| `protectRecentMessages` | `8` | 最近 N 条消息永不压缩 |
| `retainTokens` | `30000` | 压缩时尾部逐字保留的最小 token 预算 |
| `protectKeywords` | `[]` | 含这些词的节点永不压缩 |
| `pruneToolResults` | `true` | 工具结果价值剪枝 |
| `pollutionCleanup` | `true` | 污染检测与清理 |
| `minSavingsTokens` | `20000` | 压缩最低节省量（防抖动） |
| `inspectIntervalMs` | `15000` | 每会话巡检间隔 |

在 `cordis.patch.yml` 的 entry 上加 `config:` 即可覆盖：

```yaml
- insert:
    - id: context-guardian
      name: '@dsh-my-plugin/context-guardian'
      config:
        protectKeywords: ['密码', 'token']
        compactTokens: 150000
```

## 异常隔离说明

- 不 `provide`/覆盖 `ctx.compaction`、`ctx.tokenMeter` 等任何平台服务；
- 所有改动通过 Session 官方 `append + surfaceOp replace` 协议落地，与平台压缩
  同一套机制（`startSeq/endSeq` 表面位置 + `sourceEventSeqs` 源引用）；
- 每个操作单独 try/catch，压缩事务失败由平台自身回滚，插件只记日志；
- 所有监听器经 `ctx.effect` 注册，插件卸载零残留；
- 纯函数核心（config/scan/execute）脱离运行时单测，42 个用例覆盖阈值分级、
  价值扫描、retainTokens 保留策略、配对平衡回退、影子价格协议、剪枝、
  提前干预与溢出恢复、异常隔离。

## 开发

```bash
pnpm --filter @dsh-my-plugin/context-guardian typecheck
pnpm --filter @dsh-my-plugin/context-guardian test
pnpm --filter @dsh-my-plugin/context-guardian build
```
