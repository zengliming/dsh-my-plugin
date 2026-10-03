import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: false,
  clean: false,
  // platform 默认 node 时 fixedExtension 为 true 会把产物改成 .mjs；本包是
  // type: module，关闭后产物为 lib/index.js，与 exports 声明一致。
  fixedExtension: false,
  // 全部 node_modules 依赖保持 external；本包几乎无运行时依赖，仅 node: 内置模块。
  deps: {
    skipNodeModulesBundle: true,
  },
})