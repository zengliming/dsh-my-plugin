# dsh-my-plugin

个人 DSH（DeepSeek Harness）插件仓库：集中管理自己定义的全部插件。

采用 **pnpm monorepo** 结构，`packages/*` 每目录一个独立插件包。每个插件都是标准 npm 包，通过 `dsh plugin --profile <profile> add <包规格>`（本地 `link:` 路径 / npm 包名 / GitHub git URL）装入 DSH，详见下文「安装到 DSH」。

## 第一设计原则：插件异常绝不影响 DSH 本体

本仓库的所有插件必须遵守故障隔离红线。这一原则有三层技术保障：

### 1. 加载器隔离（DSH 平台自带）

Cordis loader 将每个插件包作为独立模块加载。单个插件的 `apply` 抛错只会让该插件加载失败，不会让 DSH 进程崩溃。对非关键插件，在 `cordis.patch.yml` 的 entry 上追加 `failOnStartupError: false` 可让 DSH 在插件启动失败时继续运行（`~/.dsh/cordis.patch.yml` 中 mcp-siyuan 即此用法）。

### 2. 插件内代码边界（仓库强制规范）

```ts
// ✅ 正确：apply 内注册逻辑包 try/catch，失败记日志，不向上抛
export function apply(ctx: Context, config: Config = {}): void {
  try {
    ctx.tools.register(defineTool({ /* ... */ }))
  } catch (error) {
    ctx.logger('my-plugin').error('register failed: %s', message(error))
  }
}

// ✅ 正确：异步监听器 / 工具执行器内部捕获，异常只影响本次调用
async execute(args) {
  try { return await risky(args) } catch (error) { return { error: message(error) } }
}
```

**红线（禁止）：**

- ❌ `process.exit()`、`process.abort()`、`process.kill(process.pid)`
- ❌ 修改全局对象 / 原型（`globalThis.xxx = ...`、`Array.prototype.*`）
- ❌ 向 `process` 挂 `uncaughtException` / `unhandledRejection` 监听来"吞错"
- ❌ 在模块顶层执行副作用代码（`apply` 之外不能有网络/文件/定时器）
- ❌ 不经过 try/catch 地让异步回调、事件监听器、Promise 链上的异常逃逸
- ❌ 依赖未在 package.json 声明的包（装不进 profile 的 node_modules 会直接加载失败）

**必须做到：**

- 所有资源（定时器、WebSocket、监听器、子进程）通过 `ctx.effect`/`ctx.on` 注册清理，插件卸载时能完全回收
- 工具 `execute` 永不向引擎抛异常：失败返回可读错误文本
- apply 导出的 `Config` 用 schemastery 定义并给默认值，保证"无配置也能加载"
- 日志使用 `ctx.logger('包名')`，不用 `console.*` 打全局

### 3. 仓库级校验

新增/修改插件后必须通过构建与类型检查（CI 脚本见下），把类型错误、悬空导出挡在进入 DSH 之前。

## 仓库结构

```
dsh-my-plugin/
├── package.json              # workspace 根（private，聚合脚本）
├── pnpm-workspace.yaml       # packages/* 全部收编
├── tsconfig.base.json        # 共享 TS 严格配置
├── .npmrc                    # registry 等 npm 配置
├── README.md                 # 本文件
├── AGENTS.md                 # 给 AI 助手/协作者的开发约束
└── packages/
    └── hello-world/          # 示例插件 = 新插件模板
```

## 常用命令

```bash
pnpm install                                            # 安装全部依赖
pnpm build                                              # 构建所有插件
pnpm typecheck                                          # 类型检查所有插件
pnpm test                                               # 运行所有插件测试
pnpm --filter @dsh-my-plugin/hello-world build          # 构建单个插件
```

## 新增一个插件

1. 复制 `packages/hello-world/` 为 `packages/<name>/`；
2. 改 `package.json` 的 `name`（建议 `@dsh-my-plugin/<name>`）与 `description`；
3. 改 `cordis.patch.yml` 的 `id` 与 `name`；
4. 在 `src/index.ts` 写 `name` / `inject` / `apply(ctx, config)`；
5. `pnpm install && pnpm build` 通过后提交。

## 安装到 DSH

```bash
# 方式一：本地链接（开发期，指向仓库内包目录）
dsh plugin --profile web add link:<绝对路径>/packages/hello-world

# 方式二：从 npm（发布后）
dsh plugin --profile web add @dsh-my-plugin/hello-world
```

### 方式三：从 GitHub 安装

`dsh plugin add` 的包规格与 npm 一致，支持 git URL 作为来源。前提是安装目标本身是一个结构完整的 npm 插件包（仓库根 `package.json` 就是插件）：

```bash
# 独立仓库（根即插件包）直接用 git URL 安装：
dsh plugin --profile web add git+https://github.com/<owner>/<repo>.git

# 指定分支 / tag / commit：
dsh plugin --profile web add git+https://github.com/<owner>/<repo>.git#main
dsh plugin --profile web add git+https://github.com/<owner>/<repo>.git#v1.0.0
```

> ⚠️ **monorepo 注意**：本仓库是 pnpm workspace，插件位于 `packages/*` 子目录；git URL 安装只认仓库根包，而根 `package.json` 是 private（非插件），所以**不能**用 `git+https://…` 直接安装本仓库的子包。GitHub 方式对本仓库要走「先克隆、再 link」：

```bash
git clone https://github.com/<owner>/dsh-my-plugin.git
dsh plugin --profile web add link:D:/path/to/dsh-my-plugin/packages/hello-world
```

## 许可

MIT（各插件包独立声明）。