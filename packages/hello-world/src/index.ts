/**
 * hello-world：DSH 插件最小完整示例。
 *
 * 本包演示一个新插件需要具备的全部要素：
 *  - `name` / `inject` / `apply`：Cordis 插件入口约定；
 *  - `Config`：schemastery 配置 schema（加载器会用它对清单里的 config 做校验与补默认值）；
 *  - `ctx.tools.register(defineTool(...))`：向模型暴露一个工具；
 *  - 错误边界：所有异步执行路径都捕获异常并转为可读结果，绝不让插件异常
 *    冒泡到 DSH 本体（异常隔离是本仓库的第一设计原则，详见仓库根 README）。
 * @module @dsh-my-plugin/hello-world
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** 插件在 cordis.patch.yml 中的行 id（bundle 层由 loader 注入，此处仅文档说明）。 */
export const name = 'hello-world'

/** apply 阶段需要注入的服务：tools 用于注册模型工具。 */
export const inject = ['tools']

/**
 * 部署配置。interface 保持全部可选，schema 为每个字段提供默认值，
 * 这样清单里即使不带 config 也能正常加载（与生态中"无配置安装"约定一致）。
 */
export interface Config {
  /** 问候语模板，`{name}` 会被替换为调用参数中的名字；默认 `Hello, {name}!`。 */
  greeting?: string
  /** 是否把结果转为大写；默认 false。 */
  uppercase?: boolean
}

/** Schemastery 配置 schema；同时可被设置页复用为插件配置表单。 */
export const Config = z.object({
  greeting: z.string().default('Hello, {name}!'),
  uppercase: z.boolean().default(false),
})

/**
 * 纯函数：组装问候语文本。独立出来便于单元测试，不依赖 Cordis 运行时。
 * @param greeting - 模板字符串。
 * @param who - 名字（已 trim，可为空串）。
 * @param uppercase - 是否大写。
 * @returns 最终问候语。
 */
export function composeGreeting(greeting: string, who: string, uppercase: boolean): string {
  const text = greeting.replace('{name}', who)
  return uppercase ? text.toUpperCase() : text
}

/**
 * 插件应用函数：向 `ctx.tools` 注册 hello_world 工具。
 * apply 本身不抛错——注册失败也被捕获并记录，保证插件异常不影响 DSH 本体。
 * @param ctx - 注册上下文。
 * @param config - 部署配置（schema 已补默认值）。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const greeting = config.greeting ?? 'Hello, {name}!'
  const uppercase = config.uppercase ?? false
  const logger = ctx.logger('hello-world')

  try {
    ctx.tools.register(defineTool({
      name: 'hello_world',
      description:
        'Return a friendly greeting. Use when the user says hello or asks to be greeted. '
        + 'Accepts an optional name and returns a greeting text built from a configurable template.',
      parameters: {
        name: {
          type: 'string',
          description: 'The name to greet. When omitted, greets "world".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        // 错误边界：单次调用失败只影响本次结果，绝不向引擎抛异常。
        try {
          const who = (args.name ?? '').trim() || 'world'
          return { text: composeGreeting(greeting, who, uppercase) }
        } catch (error) {
          logger.warn('hello_world call failed: %s', error instanceof Error ? error.message : String(error))
          return { text: `hello_world failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }))
  } catch (error) {
    // 注册阶段失败：记录后静默返回，插件加载失败不影响 DSH 进程。
    logger.error('hello-world failed to register: %s', error instanceof Error ? error.message : String(error))
  }
}
