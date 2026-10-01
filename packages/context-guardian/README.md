# @dsh-my-plugin/context-guardian（上下文守护者）

针对每个会话的上下文做**价值感知的自动压缩与剪枝**：保留有用信息，清理污染，
避免上下文过长或被污染。

## 功能

- **压力观测**：用平台 `tokenMeter` 持续测量每个会话的总 token 压力，分级为
  `watch → prune → compact → critical`；
- **价值感知压缩**：扫描表面节点，识别高价值信息（用户指令、关键词命中、最近
  对话、已有摘要）并保护；对低价值区间调用平台 `compaction.compactRegion` 定点
  压缩成摘要——近期对话与关键指令**永不**进入压缩范围；
- **价值剪枝**：对超长工具结果做头/尾保留剪枝（保留 40% 预算的头部与尾部关键
  信息，中间截断并标记），模型无关、零成本；
- **污染清理**：识别连续失败堆积（仅保留最后一次）、重复行噪音等，替换为极简
  占位，防止上下文被污染；
- **异常隔离（仓库第一原则）**：协作者模式——不覆盖任何平台服务，所有平台调用
  与事件监听都在各自 try/catch 内，插件失败只记日志，绝不影响 DSH 本体。

## 工作原理

```
session/event (user/assistant/tool 消息)
      │ 去抖调度（默认 15s/会话）
      ▼
  tokenMeter.measure() ──► 压力分级
      │
      ├─ watch:     仅记录日志
      ├─ prune:     污染清理 → 价值剪枝
      ├─ compact:   污染清理 → 价值剪枝 → 低价值区间压缩
      └─ critical:  同上（最大化干预）
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
  同一套机制；
- 每个操作单独 try/catch，压缩事务失败由平台自身回滚，插件只记日志；
- 所有监听器经 `ctx.effect` 注册，插件卸载零残留；
- 纯函数核心（config/scan/execute）脱离运行时单测，26 个用例覆盖阈值分级、
  价值扫描、污染检测、剪枝与区间选择。

## 开发

```bash
pnpm --filter @dsh-my-plugin/context-guardian typecheck
pnpm --filter @dsh-my-plugin/context-guardian test
pnpm --filter @dsh-my-plugin/context-guardian build
```
