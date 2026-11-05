/**
 * 插件配置定义（Schemastery schema）。
 *
 * 约定（见 DSH 官方《插件配置》教程）：
 * - 导出同名的 `Config` 类型与 `Config` schema，默认值直接写在 schema 里；
 * - 凡是不同部署可能取不同值的参数，都要做成配置字段，而不是硬编码常量；
 * - 配置不合法时在插件加载阶段直接失败（"配置错误要响亮"）。
 *
 * 用户在 `cordis.yml` / profile 的 `cordis.patch.yml` 中这样覆盖：
 *
 * ```yaml
 * - insert:
 *     - id: badcase-analyzer
 *       name: 'dsh-badcase-analyzer'
 *       config:
 *         strategy: rule-then-llm
 *         llm:
 *           model: deepseek-v4-flash
 *         report:
 *           outputPath: ./reports/badcase.json
 * ```
 */

import Schema from '@deepseek-ai/schemastery'

import { ATTRIBUTION_STRATEGIES } from './attribution/types.ts'
import type { AttributionStrategy } from './attribution/types.ts'

// 策略是归因层的概念，这里只是把它暴露成配置项（单一事实来源在 attribution/types.ts）。
export { ATTRIBUTION_STRATEGIES }
export type { AttributionStrategy }

/** LLM 归因相关配置。 */
export interface LlmAttributionConfig {
  /**
   * DSH 的 provider 路由名（`ctx.llm.stream({ provider })` 用它选 adapter）。
   * 默认值与 DSH base 组合包的默认会话模型保持一致。
   */
  provider: string
  /** 模型 id。 */
  model: string
  /**
   * 采样温度。归因任务要求可复现，默认 0。
   * 注意：非法值不会报错，但会显著影响分类稳定性，别随手调高。
   */
  temperature: number
  /** 单次归因调用的输出上限（token）。 */
  maxOutputTokens: number
  /** 单次归因调用的超时（毫秒），超时后按超时处理。 */
  timeoutMs: number
  /** LLM 调用失败（网络/超时/JSON 解析失败）时，是否回退到规则引擎结果。 */
  fallbackToRules: boolean
}

/** 规则引擎相关配置。 */
export interface RuleEngineConfig {
  /**
   * 规则命中置信度阈值（0~1）。
   * 低于该阈值视为「规则没把握」：`rule` 策略下标记为未分类，
   * `rule-then-llm` 策略下转交 LLM 复核。
   */
  confidenceThreshold: number
  /**
   * 追加自定义关键词：`{ 归因类别 key: [关键词...] }`。
   * 用于把业务词表（产品名、行业术语）喂给规则引擎，避免改代码。
   */
  extraKeywords: Record<string, string[]>
}

/** 报告输出相关配置。 */
export interface ReportConfig {
  /** 是否把完整 JSON 报告写入磁盘（false 时只作为工具返回值返回）。 */
  writeFile: boolean
  /** 报告输出路径：相对路径按 DSH 进程工作目录解析。 */
  outputPath: string
  /** 模型可见文本里是否带上每条 Case 的判据（evidence）。 */
  includeEvidence: boolean
  /** 模型可见文本里最多列出多少条 Case 明细（完整明细始终在 JSON 报告里）。 */
  maxDetailLines: number
}

/** 插件配置根。 */
export interface Config {
  /** 默认归因策略（工具入参 `strategy` 可单次覆盖）。 */
  strategy: AttributionStrategy
  /** 单次最多分析多少条失败用例，防止一次吞下超大评测结果把上下文打爆。 */
  maxCases: number
  /** LLM 归因配置。 */
  llm: LlmAttributionConfig
  /** 规则引擎配置。 */
  rules: RuleEngineConfig
  /** 报告输出配置。 */
  report: ReportConfig
}

/** 与 `Config` 类型同名的 Schemastery schema，Cordis 加载插件时用它校验并补默认值。 */
export const Config: Schema<Config> = Schema.object({
  strategy: Schema.union(ATTRIBUTION_STRATEGIES).default('rule'),
  maxCases: Schema.natural().min(1).default(200),

  llm: Schema.object({
    // TODO(校验): `deepseek-official` / `deepseek-v4-flash` 取自你本机 DSH base 组合包的
    // 默认值；如你的部署用了别的 provider 路由名，以 `dsh --dump-config` 的结果为准。
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string().default('deepseek-v4-flash'),
    temperature: Schema.number().min(0).max(2).default(0),
    maxOutputTokens: Schema.natural().min(1).default(1024),
    timeoutMs: Schema.natural().min(1000).default(30_000),
    fallbackToRules: Schema.boolean().default(true),
  }),

  rules: Schema.object({
    confidenceThreshold: Schema.number().min(0).max(1).default(0.55),
    extraKeywords: Schema.dict(Schema.array(Schema.string())).default({}),
  }),

  report: Schema.object({
    writeFile: Schema.boolean().default(true),
    outputPath: Schema.string().default('./badcase-report.json'),
    includeEvidence: Schema.boolean().default(true),
    maxDetailLines: Schema.natural().min(0).default(20),
  }),
})
