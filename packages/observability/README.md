# @dsh-my-plugin/observability

个人 DSH 插件仓库的**共享可观测性层**：统一的结构化事件记录、`$DSH_HOME` 下
JSON 原子持久化、指标聚合与查询。所有 `@dsh-my-plugin/*` 插件共用，用于度量
插件效果并支撑后续优化。

## 设计

```
插件动作（剪枝/压缩/污染清理/溢出恢复/工具调用）
      │ obs.record({ kind, ok, tokensSaved, charsSaved, ... })
      ▼
  事件聚合（纯函数）──► 查询（stats() / guardian_stats 工具）
      │
      ▼
  持久化：$DSH_HOME/observability/events.json（原子写，上限 1 万条）
```

## 用法

```ts
import { createObservability } from '@dsh-my-plugin/observability'

const obs = createObservability({ plugin: '@dsh-my-plugin/context-guardian' })

// 记录一条事件（永不抛错；失败返回 false）
obs.record({ kind: 'prune', ok: true, tokensSaved: 1200, charsSaved: 4800 })

// 查询聚合统计（含跨重启的持久化历史）
const stats = obs.stats()          // PluginStats[]
obs.summarize(logger)              // 日志一行汇总
```

## 事件模型

| 字段 | 说明 |
|---|---|
| `plugin` | 事件源插件（包名） |
| `kind` | 动作类别：`prune` / `compact` / `pollution-cleanup` / `overflow-recovery` / `tool-call` / `inspect` / `error` |
| `ts` | 时间（epoch ms） |
| `sessionId` | 会话 id（可空） |
| `ok` | 是否成功 |
| `tokensSaved` | 节省 token 数（剪枝/压缩关键指标） |
| `charsSaved` | 节省字符数 |
| `count` | 处理数量 / 调用次数 |
| `pressureLevel` | 压力分级 |
| `detail` / `extra` | 细节与扩展字段 |

## 持久化

- 路径：`$DSH_HOME/observability/events.json`（`DSH_HOME` 未设则 `~/.dsh`）
- 原子写（write-temp + rename），损坏文件容错回退为空
- 保留上限 1 万条事件，超出丢弃最旧（聚合统计不丢，历史明细有上限）
- 写盘失败只返回 `false`，绝不影响插件主流程

## 开发

```bash
pnpm --filter @dsh-my-plugin/observability typecheck
pnpm --filter @dsh-my-plugin/observability test
pnpm --filter @dsh-my-plugin/observability build
```