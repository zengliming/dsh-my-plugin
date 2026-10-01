import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: false,
  // 声明文件由 tsc -b 生成到 lib/types/（见 tsconfig.json），这里只产出 JS bundle。
  clean: false,
  // platform 默认 node 时 fixedExtension 为 true，会把产物强制改成 .mjs；
  // 本包 package.json 是 type: module，关闭后产物为 lib/index.js，与 exports 声明一致。
  fixedExtension: false,
  // 所有 node_modules 依赖保持 external（不打包进 bundle）：
  //  @deepseek-ai/* 平台包由 DSH 运行时提供（peer），@deepseek-ai/schemastery 与
  //  node: 内置模块按安装树解析——与生态插件（dsh-tool-describe-image 等）行为一致，
  //  保证插件与宿主共享同一服务实例与类型。
  deps: {
    skipNodeModulesBundle: true,
  },
})