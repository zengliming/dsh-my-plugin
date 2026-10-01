# @dsh-my-plugin/hello-world

DSH 插件最小完整示例：向模型暴露一个 `hello_world` 工具。

## 功能

- 注册模型可调用的 `hello_world` 工具（接受可选 `name` 参数，返回问候语文本）
- 可配置问候语模板与大小写（schemastery Config，可复用为设置页表单）
- 演示错误边界模式：单次调用失败只影响本次结果，绝不向引擎抛异常

## 目录结构（新插件的模板）

```
packages/hello-world/
├── package.json        # dsh.bundle.patch 指向 cordis.patch.yml；exports 声明 Host 入口
├── cordis.patch.yml    # 清单：向 profile 注册 id=hello-world → @dsh-my-plugin/hello-world
├── tsconfig.json       # tsc -b 输出声明到 lib/types/
├── tsdown.config.ts    # JS bundle 输出到 lib/
└── src/
    ├── index.ts        # name/inject/apply + Config + 工具注册
    └── index.test.ts   # 纯函数单元测试（vitest）
```

复制本目录（改名、改 package.json 的 name/description 与 cordis.patch.yml 的 id/name）即可开始写新插件。

## 开发

```bash
pnpm install           # 仓库根：安装全部 workspace 依赖
pnpm --filter @dsh-my-plugin/hello-world build      # tsc -b && tsdown
pnpm --filter @dsh-my-plugin/hello-world typecheck
pnpm --filter @dsh-my-plugin/hello-world test
```

## 安装到 DSH

本地链接安装（推荐开发期使用）：

```bash
dsh plugin --profile web add link:<本仓库绝对路径>/packages/hello-world
```

发布到 npm 后：

```bash
dsh plugin --profile web add @dsh-my-plugin/hello-world
```

安装后模型即可调用 `hello_world` 工具。若希望 DSH 在插件启动失败时仍继续运行（异常隔离的最后一层保险），可在清单 entry 加 `failOnStartupError: false`（见仓库根 README）。

## 异常隔离约定

- `apply` 内部所有注册代码包在 try/catch 里，失败只记日志，不向上抛；
- 工具 `execute` 内部捕获异常并返回可读结果，不让异常冒泡到引擎；
- 不使用 `process.exit`、不修改全局对象、不向 `process` 挂 uncaught 监听。
