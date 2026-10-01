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
})