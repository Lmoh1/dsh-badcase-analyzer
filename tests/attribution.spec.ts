import { describe, expect, it } from 'vitest'

import { attributeCase, attributeCases, countByMethod } from '../src/attribution/index.ts'
import type { AttributionDeps } from '../src/attribution/index.ts'
import { UNCLASSIFIED } from '../src/attribution/types.ts'
import type { AnalyzedCase } from '../src/attribution/types.ts'
import {
  AMBIGUOUS_CASE,
  ENTITY_CASE,
  HALLUCINATION_CASE,
  INTENT_CASE,
  LLM_REPLY_OK,
  SAMPLE_CASES,
  createFakeLlm,
} from './support/fakes.ts'

/** 与 src/config.ts 默认值一致的规则配置。 */
const RULES = { confidenceThreshold: 0.55 }

/** 测试用模型参数。 */
const LLM = { provider: 'test-provider', model: 'test-model', temperature: 0, maxOutputTokens: 256, timeoutMs: 1_000 }

function categories(cases: readonly AnalyzedCase[]): string[] {
  return cases.map(item => item.category)
}

function methods(cases: readonly AnalyzedCase[]): string[] {
  return cases.map(item => item.method)
}

/** 纯规则编排（不注入 LLM 服务）。 */
function ruleOnly(): AttributionDeps {
  return { strategy: 'rule', rules: RULES, llm: LLM }
}

describe('strategy: rule —— 零成本、可复现', () => {
  it('只跑规则引擎，完全不去碰 LLM 服务', async () => {
    const analyzed = await attributeCases(SAMPLE_CASES, ruleOnly())

    expect(categories(analyzed)).toEqual([
      'intent_misunderstanding',
      'entity_omission',
      'logic_hallucination',
      UNCLASSIFIED,
    ])
    expect(methods(analyzed)).toEqual(['rule', 'rule', 'rule', 'rule'])
    expect(countByMethod(analyzed)).toEqual({ rule: 4 })
  })

  it('单条入口 attributeCase 与批量结果一致', async () => {
    const single = await attributeCase(ENTITY_CASE, ruleOnly())
    const batch = await attributeCases([ENTITY_CASE], ruleOnly())

    expect(single).toEqual(batch[0])
  })
})

describe('strategy: llm —— 全部交给模型', () => {
  it('每条都调用一次模型，结论来自模型输出', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)
    const analyzed = await attributeCases(SAMPLE_CASES, { strategy: 'llm', rules: RULES, llm: LLM, llmStreamer: llm })

    expect(llm.callCount).toBe(SAMPLE_CASES.length)
    expect(methods(analyzed)).toEqual(['llm', 'llm', 'llm', 'llm'])
    expect(categories(analyzed)).toEqual(['entity_omission', 'entity_omission', 'entity_omission', 'entity_omission'])
  })

  it('模型拿到的提示词里带着该条用例的 caseId（不会串行串味）', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)
    await attributeCases(SAMPLE_CASES, { strategy: 'llm', rules: RULES, llm: LLM, llmStreamer: llm })

    expect(llm.calls[0]?.userPrompt).toContain('cs-001')
    expect(llm.calls[1]?.userPrompt).toContain('cs-003')
    expect(llm.calls[2]?.userPrompt).toContain('cs-005')
  })
})

describe('LLM 失败时的降级（单条失败不拖垮整批）', () => {
  it('默认回退到规则结论，并标记 method=fallback', async () => {
    const failing = createFakeLlm(new Error('模拟网络错误'))
    const fallback = await attributeCases(SAMPLE_CASES, {
      strategy: 'llm',
      rules: RULES,
      llm: LLM,
      llmStreamer: failing,
    })
    const ruleOnlyResult = await attributeCases(SAMPLE_CASES, ruleOnly())

    expect(methods(fallback)).toEqual(['fallback', 'fallback', 'fallback', 'fallback'])
    // 降级后的类别与纯规则结论一致：不会因为 LLM 挂了就整体变"未分类"
    expect(categories(fallback)).toEqual(categories(ruleOnlyResult))
    expect(fallback[0]?.evidence.at(-1)).toContain('回退规则结果')
  })

  it('关闭回退时一律未分类，并保留失败原因', async () => {
    const failing = createFakeLlm(new Error('模拟网络错误'))
    const analyzed = await attributeCases(SAMPLE_CASES, {
      strategy: 'llm',
      rules: RULES,
      llm: LLM,
      llmStreamer: failing,
      fallbackToRules: false,
    })

    expect(categories(analyzed)).toEqual([UNCLASSIFIED, UNCLASSIFIED, UNCLASSIFIED, UNCLASSIFIED])
    expect(methods(analyzed)).toEqual(['fallback', 'fallback', 'fallback', 'fallback'])
    expect(analyzed[0]?.evidence[0]).toContain('LLM 归因失败')
  })

  it('没注入 LLM 服务时也不会崩，而是降级', async () => {
    const analyzed = await attributeCases([INTENT_CASE], { strategy: 'llm', rules: RULES, llm: LLM })

    expect(methods(analyzed)).toEqual(['fallback'])
    expect(analyzed[0]?.evidence.join('')).toContain('LLM 服务不可用')
  })
})

describe('strategy: rule-then-llm —— 只为没把握的用例花钱', () => {
  it('规则有把握的直接用，只有未分类的那条交给模型', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)
    const analyzed = await attributeCases(SAMPLE_CASES, {
      strategy: 'rule-then-llm',
      rules: RULES,
      llm: LLM,
      llmStreamer: llm,
    })

    expect(llm.callCount).toBe(1)
    expect(countByMethod(analyzed)).toEqual({ rule: 3, llm: 1 })
    // 交给模型的那条，结论采用模型给的
    expect(analyzed[3]?.caseId).toBe(AMBIGUOUS_CASE.caseId)
    expect(analyzed[3]?.category).toBe('entity_omission')
    expect(analyzed[3]?.method).toBe('llm')
  })

  it('模型失败时这条回退到规则结论（此时就是未分类）', async () => {
    const failing = createFakeLlm(new Error('模拟超时'))
    const analyzed = await attributeCases(SAMPLE_CASES, {
      strategy: 'rule-then-llm',
      rules: RULES,
      llm: LLM,
      llmStreamer: failing,
    })

    expect(countByMethod(analyzed)).toEqual({ rule: 3, fallback: 1 })
    expect(analyzed[3]?.category).toBe(UNCLASSIFIED)
  })

  it('规则全部有把握时一次都不调模型', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)
    const analyzed = await attributeCases([INTENT_CASE, ENTITY_CASE, HALLUCINATION_CASE], {
      strategy: 'rule-then-llm',
      rules: RULES,
      llm: LLM,
      llmStreamer: llm,
    })

    expect(llm.callCount).toBe(0)
    expect(methods(analyzed)).toEqual(['rule', 'rule', 'rule'])
  })
})

describe('编排的通用契约', () => {
  it('输出顺序与输入顺序严格一致（便于前后批次对比）', async () => {
    const analyzed = await attributeCases(SAMPLE_CASES, ruleOnly())

    expect(analyzed.map(item => item.caseId)).toEqual(SAMPLE_CASES.map(item => item.caseId))
  })

  it('每条结果都带 categoryLabel，且与 category 对得上', async () => {
    const analyzed = await attributeCases(SAMPLE_CASES, ruleOnly())

    for (const item of analyzed) {
      expect(item.categoryLabel.length).toBeGreaterThan(0)
    }
    expect(analyzed[0]?.categoryLabel).toBe('意图识别偏差')
    expect(analyzed[1]?.categoryLabel).toBe('实体抽取遗漏')
    expect(analyzed[2]?.categoryLabel).toBe('逻辑幻觉')
  })

  it('可选的 expected / tags 会被透传，不会丢字段', async () => {
    const analyzed = await attributeCases([INTENT_CASE], ruleOnly())

    expect(analyzed[0]?.expected).toBe(INTENT_CASE.expected)
    expect(analyzed[0]?.tags).toEqual(INTENT_CASE.tags)
  })

  it('已中止的信号让批量归因立刻失败', async () => {
    await expect(
      attributeCases(SAMPLE_CASES, { ...ruleOnly(), signal: AbortSignal.abort() }),
    ).rejects.toThrow()
  })
})
