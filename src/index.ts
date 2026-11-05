/**
 * `dsh-badcase-analyzer` 插件入口。
 *
 * Cordis 插件 = 导出 `apply(ctx, config)` 的 ES Module。本文件只做三件事：
 * 1. 声明插件名与依赖的服务（`name` / `inject`）；
 * 2. 把 `src/config.ts` 的 Schemastery schema 作为 `Config` 导出（Cordis 用它校验并补默认值）；
 * 3. 在 `apply` 里把 `badcase_analyze` 注册进工具注册表。
 *
 * 不需要任何手动清理：通过 `ctx` 注册的东西（工具、监听器、定时器）在插件卸载时
 * 由框架自动注销 —— 注册即副作用，dispose 即回收。
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config as ConfigSchema } from './config.ts'
import type { Config as BadCaseAnalyzerConfig } from './config.ts'
import { badcaseAnalyzeTool } from './tool/badcase-analyze.ts'

/** 插件名，出现在 loader 日志、`tools/result` 的 source 与诊断信息里。 */
export const name = 'badcase-analyzer'

/**
 * 依赖的服务。Cordis 会等这些服务就绪后再调用 `apply`。
 *
 * - `tools`：工具注册表（`ctx.tools.register`），必需；
 * - `llm`：大模型服务（`ctx.llm.stream`），`strategy: llm | rule-then-llm` 需要它。
 *
 * 注：`llm` 声明为必需依赖时，缺少该服务的组合里本插件会停在 PENDING 而不是报错崩掉，
 * 这是 Cordis 的正常行为。若你希望"没有 llm 也能用纯规则模式"，改成
 * `export const inject = ['tools']`，并把第三步的 LLM 调用改成惰性获取
 * （`ctx.get('llm')` + 可用性判断）。
 *
 * TODO(校验): 不同 DSH 版本的 llm 服务名/获取方式若发生变化，以官方文档为准。
 */
export const inject = ['tools', 'llm']

/**
 * 插件配置 schema。同名导出是 Cordis 的约定：loader 读取 `module.Config`，
 * 用它校验 `cordis.yml` 里该插件行的 `config`，并填充未提供字段的默认值。
 */
export const Config = ConfigSchema

/** 配置类型，供外部（测试、其他插件）import。 */
export type { BadCaseAnalyzerConfig }

/**
 * 插件主体。`config` 已由框架校验并补全默认值，可以直接当完整配置用。
 *
 * @param ctx - Cordis 上下文，`ctx.tools` 在此已就绪（见 `inject`）。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: BadCaseAnalyzerConfig): void {
  // 注册基于副作用：这个工具的生命周期与本插件 fiber 绑定，卸载即注销。
  ctx.tools.register(badcaseAnalyzeTool({ ctx, config }))
}

// 便于使用方按需引用内部实现（测试、脚本化调用、复用归因层）。
export { ATTRIBUTION_CATEGORY_KEYS, ATTRIBUTION_CATEGORY_LABELS, TOOL_NAME } from './tool/badcase-analyze.ts'
export { badcaseAnalyzeTool, loadBadCases, renderReportText } from './tool/badcase-analyze.ts'

// 归因层：三种策略的编排 + 规则引擎 + LLM 归因都可以单独 import 复用（单测/脚本）。
export { attributeCase, attributeCases, countByMethod } from './attribution/index.ts'
export type { AttributionDeps } from './attribution/index.ts'
export { attributeWithRules, extractEntities } from './attribution/rules.ts'
export type { RuleEngineOptions, RuleHit, RuleResult } from './attribution/rules.ts'
export {
  ATTRIBUTION_SYSTEM_PROMPT,
  LlmAttributionError,
  attributeWithLlm,
  buildAttributionUserPrompt,
  parseAttributionReply,
} from './attribution/llm.ts'
export type { LlmAttributeOptions, LlmCallSettings, LlmStreamer } from './attribution/llm.ts'

export type {
  AnalyzedCase,
  AttributionCategoryKey,
  AttributionMethod,
  AttributionVerdict,
  BadCase,
  BadCaseReport,
  LoadedCases,
  ReportSummary,
  SkippedCase,
} from './tool/badcase-analyze.ts'
export type { AttributionStrategy } from './config.ts'
