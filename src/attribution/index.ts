/**
 * 归因编排：把「规则引擎」与「LLM」组合成三种策略。
 *
 * | strategy | 行为 |
 * | --- | --- |
 * | `rule` | 只跑规则引擎；低于阈值 → `unclassified`（零成本、可复现） |
 * | `llm` | 只跑 LLM；失败时按 `fallbackToRules` 决定回退规则结果还是标未分类 |
 * | `rule-then-llm` | 规则有把握直接用；没把握才交给 LLM（成本与召回折中，推荐） |
 *
 * 编排只做决策，不碰 IO、不碰报告：输入 `BadCase[]`，输出 `AnalyzedCase[]`。
 * 这样工具层、脚本、单测都可以直接复用这一层。
 */

import {
  ATTRIBUTION_CATEGORY_LABELS,
  UNCLASSIFIED,
  defaultSuggestion,
} from './types.ts'
import type {
  AnalyzedCase,
  AttributionStrategy,
  AttributionVerdict,
  BadCase,
} from './types.ts'
import { attributeWithRules } from './rules.ts'
import type { RuleEngineOptions, RuleResult } from './rules.ts'
import { LlmAttributionError, attributeWithLlm } from './llm.ts'
import type { LlmCallSettings, LlmStreamer } from './llm.ts'

/** 归因编排的依赖。 */
export interface AttributionDeps {
  /** 本次生效的策略。 */
  strategy: AttributionStrategy
  /** 规则引擎配置（阈值 + 自定义关键词）。 */
  rules: RuleEngineOptions
  /** LLM 调用参数。 */
  llm: LlmCallSettings
  /**
   * LLM 失败时是否回退规则结果（默认 true）。
   * 关闭后失败一律标未分类 —— 适合"宁缺勿滥"的评测报告。
   */
  fallbackToRules?: boolean
  /** LLM 服务；`strategy: 'rule'` 时可以不给。 */
  llmStreamer?: LlmStreamer
  /** 取消信号（转发自工具的 `exec.signal`）。 */
  signal?: AbortSignal
}

/** 把失败原因转成一句人话。 */
function describeError(error: unknown): string {
  if (error instanceof LlmAttributionError) return `[${error.code}] ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** 拍平成报告里的一条 Case（`exactOptionalPropertyTypes` 下用条件展开处理可选字段）。 */
function toAnalyzedCase(badCase: BadCase, verdict: AttributionVerdict): AnalyzedCase {
  return {
    caseId: badCase.caseId,
    question: badCase.question,
    modelAnswer: badCase.modelAnswer,
    ...badCase.expected !== undefined ? { expected: badCase.expected } : {},
    ...badCase.tags !== undefined ? { tags: badCase.tags } : {},
    category: verdict.category,
    categoryLabel: ATTRIBUTION_CATEGORY_LABELS[verdict.category],
    confidence: verdict.confidence,
    method: verdict.method,
    evidence: verdict.evidence,
    suggestion: verdict.suggestion,
  }
}

/**
 * LLM 路径没走通时的降级结论。
 *
 * @param ruleResult - 已算好的规则结果（可能不存在）。
 * @param reason - 失败原因（会写进判据，方便排查）。
 * @param allowFallback - 是否允许回退到规则结果。
 */
function degrade(
  ruleResult: RuleResult | undefined,
  reason: string,
  allowFallback: boolean,
): AttributionVerdict {
  if (allowFallback && ruleResult !== undefined) {
    return {
      ...ruleResult.verdict,
      // 结果来自规则，但这一次是"因为 LLM 失败才用它"，所以标记为 fallback。
      method: 'fallback',
      evidence: [...ruleResult.verdict.evidence, `LLM 归因未完成，已回退规则结果：${reason}`],
    }
  }
  return {
    category: UNCLASSIFIED,
    confidence: 0,
    method: 'fallback',
    evidence: [`LLM 归因失败：${reason}`, '未启用规则回退，本条目需要人工复核'],
    suggestion: defaultSuggestion(UNCLASSIFIED),
  }
}

/**
 * 给**一条**用例归因（按策略决定走规则还是 LLM）。
 *
 * @param badCase - 归一化后的失败用例。
 * @param deps - 策略、规则配置、LLM 配置与服务、取消信号。
 * @returns 报告里的一条结果。
 */
export async function attributeCase(
  badCase: BadCase,
  deps: AttributionDeps,
): Promise<AnalyzedCase> {
  const allowFallback = deps.fallbackToRules !== false

  // 规则结果只在需要它的策略下计算，避免 llm 策略白花 CPU。
  const ruleResult = deps.strategy === 'llm'
    ? undefined
    : attributeWithRules(badCase, deps.rules)

  // 纯规则：直接给结论（可能未分类）。
  if (deps.strategy === 'rule' && ruleResult !== undefined) {
    return toAnalyzedCase(badCase, ruleResult.verdict)
  }

  // 规则优先：规则有把握就不再花钱调模型。
  if (
    deps.strategy === 'rule-then-llm'
    && ruleResult !== undefined
    && ruleResult.verdict.category !== UNCLASSIFIED
  ) {
    return toAnalyzedCase(badCase, ruleResult.verdict)
  }

  // 接下来必须走 LLM。
  if (deps.llmStreamer === undefined) {
    return toAnalyzedCase(badCase, degrade(ruleResult, 'LLM 服务不可用（未注入 ctx.llm）', allowFallback))
  }

  try {
    const verdict = await attributeWithLlm(badCase, {
      llm: deps.llmStreamer,
      settings: deps.llm,
      ...deps.signal !== undefined ? { signal: deps.signal } : {},
    })
    return toAnalyzedCase(badCase, verdict)
  } catch (error) {
    // 单条失败不能拖垮整批：降级为规则结果或未分类，并保留失败原因。
    // `llm` 策略下前面没算规则结果（不花冤枉 CPU），这里按需补算一次。
    const fallbackSource = ruleResult ?? (allowFallback ? attributeWithRules(badCase, deps.rules) : undefined)
    return toAnalyzedCase(badCase, degrade(fallbackSource, describeError(error), allowFallback))
  }
}

/**
 * 给一批用例归因。
 *
 * 串行执行而不是并发：`ctx.llm` 的配额与限流通常按会话算，串行更可控，
 * 并且报告顺序与输入顺序严格一致（对"同一份评测结果前后对比"很重要）。
 *
 * @param cases - 归一化后的失败用例。
 * @param deps - 策略、规则配置、LLM 配置与服务、取消信号。
 * @returns 与 `cases` 等长的归因结果。
 */
export async function attributeCases(
  cases: readonly BadCase[],
  deps: AttributionDeps,
): Promise<AnalyzedCase[]> {
  const analyzed: AnalyzedCase[] = []
  for (const badCase of cases) {
    deps.signal?.throwIfAborted()
    analyzed.push(await attributeCase(badCase, deps))
  }
  return analyzed
}

/** 各归因来源的条数统计（写报告附注、做自检时用）。 */
export function countByMethod(cases: readonly AnalyzedCase[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of cases) counts[item.method] = (counts[item.method] ?? 0) + 1
  return counts
}

export { attributeWithRules } from './rules.ts'
export { attributeWithLlm } from './llm.ts'
