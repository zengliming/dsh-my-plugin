# AGENTS.md — 给 AI 助手与协作者的开发约束

本文件约束在本仓库中修改代码的行为。DSH（DeepSeek Harness）的 agent 在操作本仓库时应遵循以下规则。

## 首要原则：插件异常绝不影响 DSH 本体

这是本仓库的最高优先级约束。修改任何插件代码时，必须保持异常隔离：

1. `apply(ctx, config)` 内的注册逻辑必须包 try/catch；失败记录到 `ctx.logger`，不向上抛。
2. 工具 `execute` / 事件监听器 / 异步回调内部必须捕获异常，失败转为可读结果返回。
3. 禁止 `process.exit`、修改全局对象/原型、挂 uncaughtException/unhandledRejection 监听、模块顶层副作用。
4. 所有定时器/网络/子进程资源必须通过 `ctx.effect` / `ctx.on` 注册，保证卸载可回收。
5. `Config` 必须用 schemastery 定义并给默认值，保证无配置也能加载。

详细规范见根 [README.md](./README.md)「第一设计原则」一节。

## 结构约定

- 每个插件一个目录 `packages/<name>/`，是独立的 npm 包。
- 插件包三要素：`package.json`（含 `dsh.bundle.patch` 指向 `cordis.patch.yml`）、`cordis.patch.yml`（`- insert:` 声明 `id` 与 `name`）、`src/index.ts`（`name`/`inject`/`apply`）。
- Host 半区源码在 `src/`，构建产物 `lib/`（JS bundle）+ `lib/types/`（声明）不入库。
- 修改 `package.json` 依赖后必须运行 `pnpm install` 更新 lockfile。

## 开发流程

- 新建插件：复制 `packages/hello-world/` 作为模板。
- 完成修改后必须通过：`pnpm --filter <包名> typecheck` 与 `pnpm --filter <包名> test`。
- 涉及所有包的改动最后跑一遍 `pnpm build` 确认整体不破坏。
- 提交信息用中文或英文均可，但必须说明改动意图。

## 其他

- 不把 `node_modules/`、`lib/`、`*.tsbuildinfo` 提交入库（.gitignore 已覆盖）。
- 不修改 DSH 安装目录（`D:\Program Files\dsh\...`）与 `~/.dsh/` 下不属于本仓库的文件。
