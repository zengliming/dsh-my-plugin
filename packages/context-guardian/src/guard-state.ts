/**
 * 会话级守卫状态（guards / overflow 重试计数）的纯函数决策层。
 *
 * 与 index.ts 的运行时（ctx 注册/事件监听）分离，便于单元测试；
 * 形状与 index 中的使用处结构类型兼容（Map<string, GuardEntry> 等）。
 * @module @dsh-my-plugin/context-guardian/guard-state
 */

/** 会话去抖条目（与 index 中的 SessionGuardState 同形状）。 */
export interface GuardEntry {
  /** 上次巡检时间（epoch ms）。 */
  readonly lastInspectAt: number
  /** 是否正在巡检（在途）。 */
  readonly inFlight: boolean
}

/** overflow 重试计数条目（与 index 中的 OverflowRetryState 同形状）。 */
export interface RetryEntry {
  /** 滑动窗口内连续重试次数。 */
  readonly count: number
  /** 最近一次重试时间（epoch ms）。 */
  readonly at: number
}

/**
 * 清理「超过 staleMs 未巡检且不在途」的会话条目（原地修改）。
 * @param entries - guards 映射（原地清理）。
 * @param now - 当前时间。
 * @param staleMs - 老化阈值（毫秒）。
 * @returns 被清理的条目数。
 */
export function pruneStaleGuards(
  entries: Map<string, GuardEntry>,
  now: number,
  staleMs: number,
): number {
  let removed = 0
  for (const [id, state] of entries) {
    if (!state.inFlight && now - state.lastInspectAt > staleMs) {
      entries.delete(id)
      removed += 1
    }
  }
  return removed
}

/**
 * 有效重试次数：窗口内的条目返回累计次数；窗口外或不存在计为 0（视为全新开始）。
 * @param entry - 重试计数条目（可空）。
 * @param now - 当前时间。
 * @param windowMs - 滑动窗口时长（毫秒）。
 * @returns 有效连续重试次数。
 */
export function effectiveRetryCount(
  entry: RetryEntry | undefined,
  now: number,
  windowMs: number,
): number {
  if (entry === undefined) return 0
  return now - entry.at < windowMs ? entry.count : 0
}

/**
 * 判断一条重试条目是否已过期（调用方应将其清理，避免地图无限增长）。
 * @param entry - 重试计数条目（可空）。
 * @param now - 当前时间。
 * @param windowMs - 滑动窗口时长（毫秒）。
 * @returns 条目存在且已过期时为 true。
 */
export function isStaleRetryEntry(
  entry: RetryEntry | undefined,
  now: number,
  windowMs: number,
): boolean {
  return entry !== undefined && now - entry.at >= windowMs
}

/**
 * 本次 overflow 是否允许尝试恢复并重试：有效重试次数未达上限则允许。
 * maxRetries = 0 时任何状态都返回 false（首次溢出即让错误传播）。
 * @param entry - 重试计数条目（可空）。
 * @param now - 当前时间。
 * @param maxRetries - 上限（允许的连续重试次数）。
 * @param windowMs - 滑动窗口时长（毫秒）。
 * @returns 允许重试为 true，应让错误传播为 false。
 */
export function overflowRetryAllowed(
  entry: RetryEntry | undefined,
  now: number,
  maxRetries: number,
  windowMs: number,
): boolean {
  return effectiveRetryCount(entry, now, windowMs) < maxRetries
}