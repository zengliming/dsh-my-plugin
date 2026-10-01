/**
 * 上下文守护者的配置与阈值判定。
 *
 * 配置分两层：schema（带默认值，供 schemastery/设置页校验）与本模块导出的
 * 纯函数（压力分级），决策层与调度层都复用这些纯函数，便于单元测试。
 * @module @dsh-my-plugin/context-guardian/config
 */

import z from '@deepseek-ai/schemastery'

/** 压力分级：依据当前 surface 总 token 相对配置阈值的位置决定动作强度。 */
export type PressureLevel = 'calm' | 'watch' | 'prune' | 'compact' | 'critical'

/** 部署配置（interface 全可选，schema 负责补默认值，保证无配置即可加载）。 */
export interface Config {
  /** 总开关：关闭后插件挂载但不执行任何干预。默认 true。 */
  enabled?: boolean
  /** 达到该 token 数开始进入观察级（记录日志，不干预）。默认 120000。 */
  watchTokens?: number
  /** 达到该 token 数触发渐进式价值剪枝。默认 160000。 */
  pruneTokens?: number
  /** 达到该 token 数触发低价值区间压缩。默认 200000。 */
  compactTokens?: number
  /** 达到该 token 数进入紧急模式（最大化干预力度）。默认 240000。 */
  criticalTokens?: number
  /** 单个工具结果超过该字符数视为候选剪枝目标。默认 4000。 */
  toolResultCharLimit?: number
  /** 最近 N 条消息永不压缩、永不剪枝（保留近期上下文）。默认 8。 */
  protectRecentMessages?: number
  /** 命中任一关键词的消息永不压缩（正则按字面量匹配）。默认 []。 */
  protectKeywords?: string[]
  /** 是否对工具结果做价值剪枝。默认 true。 */
  pruneToolResults?: boolean
  /** 是否清理明显污染（连续失败/超长噪音）的节点。默认 true。 */
  pollutionCleanup?: boolean
  /** 触发干预的最小 token 降幅，避免抖动导致反复干预。默认 20000。 */
  minSavingsTokens?: number
  /** 每个会话两次巡检的最小间隔毫秒，避免高频扫描。默认 15000。 */
  inspectIntervalMs?: number
}

/** Schemastery 配置 schema；同时可被设置页复用为插件配置表单。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  watchTokens: z.number().min(0).default(120_000),
  pruneTokens: z.number().min(0).default(160_000),
  compactTokens: z.number().min(0).default(200_000),
  criticalTokens: z.number().min(0).default(240_000),
  toolResultCharLimit: z.number().min(0).default(4_000),
  protectRecentMessages: z.number().min(0).default(8),
  protectKeywords: z.array(z.string()).default([]),
  pruneToolResults: z.boolean().default(true),
  pollutionCleanup: z.boolean().default(true),
  minSavingsTokens: z.number().min(0).default(20_000),
  inspectIntervalMs: z.number().min(0).default(15_000),
})

/** 已解析、带默认值的配置快照（决策层读取此形状）。 */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly watchTokens: number
  readonly pruneTokens: number
  readonly compactTokens: number
  readonly criticalTokens: number
  readonly toolResultCharLimit: number
  readonly protectRecentMessages: number
  readonly protectKeywords: readonly string[]
  readonly pruneToolResults: boolean
  readonly pollutionCleanup: boolean
  readonly minSavingsTokens: number
  readonly inspectIntervalMs: number
}

/** 补全默认值的纯函数：把可选项配置解析为决策层可直接使用的快照。 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    watchTokens: config.watchTokens ?? 120_000,
    pruneTokens: config.pruneTokens ?? 160_000,
    compactTokens: config.compactTokens ?? 200_000,
    criticalTokens: config.criticalTokens ?? 240_000,
    toolResultCharLimit: config.toolResultCharLimit ?? 4_000,
    protectRecentMessages: config.protectRecentMessages ?? 8,
    protectKeywords: config.protectKeywords ?? [],
    pruneToolResults: config.pruneToolResults ?? true,
    pollutionCleanup: config.pollutionCleanup ?? true,
    minSavingsTokens: config.minSavingsTokens ?? 20_000,
    inspectIntervalMs: config.inspectIntervalMs ?? 15_000,
  }
}

/**
 * 纯函数：按总 token 数给出压力分级。阈值若未严格递增，以较小阈值为准先命中，
 * 保证任意合法配置都能得到确定结果。
 * @param totalTokens - 当前 surface 估算总 token。
 * @param config - 已解析配置。
 * @returns 对应的压力级别。
 */
export function pressureLevel(totalTokens: number, config: ResolvedConfig): PressureLevel {
  if (totalTokens >= config.criticalTokens) return 'critical'
  if (totalTokens >= config.compactTokens) return 'compact'
  if (totalTokens >= config.pruneTokens) return 'prune'
  if (totalTokens >= config.watchTokens) return 'watch'
  return 'calm'
}

/** 该压力级别是否应当触发模型侧压缩（低价值区间摘要）。 */
export function shouldCompact(level: PressureLevel): boolean {
  return level === 'compact' || level === 'critical'
}

/** 该压力级别是否应当触发模型无关的价值剪枝。 */
export function shouldPrune(level: PressureLevel): boolean {
  return level === 'prune' || level === 'compact' || level === 'critical'
}

/** 该压力级别是否应当启动污染检测与清理。 */
export function shouldCleanPollution(level: PressureLevel): boolean {
  return level !== 'calm' && level !== 'watch'
}