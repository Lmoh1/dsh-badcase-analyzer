import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 *
 * - 只跑 `tests/**\/*.spec.ts`，测试直接 import `src/**` 的源码，不依赖 `lib/` 构建产物，
 *   所以改完代码可以立刻跑测试，不需要先 build。
 * - 归因层是纯函数 + 本地文件读写，没有 DOM、没有网络，因此默认环境就是 `node`。
 * - 注意：如果所在环境禁止 spawn 子进程（受限沙箱），默认的 `forks` 池会报 `spawn EPERM`，
 *   用 `vitest run --pool=threads` 绕过即可；普通开发机与 CI 用默认池即可。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // 有文件读写用例（报告落盘、临时夹具），CI 的冷盘/杀毒扫描偶尔会拖慢首写，留足余量。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // 归因结果与执行顺序无关，但报告顺序要可复现：保留默认的文件级并行，进程内串行。
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // 入口只做注册，不承担逻辑；配置 schema 由 tool.spec 覆盖
      exclude: ['src/index.ts'],
    },
  },
})
