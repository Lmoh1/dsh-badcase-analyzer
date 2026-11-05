import { describe, expect, it } from 'vitest'

import { attributeWithRules, extractEntities } from '../src/attribution/rules.ts'
import type { RuleResult } from '../src/attribution/rules.ts'
import { UNCLASSIFIED } from '../src/attribution/types.ts'
import type { BadCase } from '../src/attribution/types.ts'
import {
  AMBIGUOUS_CASE,
  ENTITY_CASE,
  HALLUCINATION_CASE,
  INTENT_CASE,
} from './support/fakes.ts'

/** 默认配置下的阈值（与 src/config.ts 的默认值保持一致）。 */
const DEFAULT_OPTIONS = { confidenceThreshold: 0.55 }

function attribute(badCase: BadCase, options: { confidenceThreshold: number } = DEFAULT_OPTIONS): RuleResult {
  return attributeWithRules(badCase, options)
}

function ruleIds(result: RuleResult): string[] {
  return result.hits.map(hit => hit.ruleId)
}

describe('规则引擎：三个维度的定性判定', () => {
  it('忽略「改成 X」这类目标变更 → 意图识别偏差', () => {
    const result = attribute(INTENT_CASE)

    expect(result.verdict.category).toBe('intent_misunderstanding')
    expect(result.verdict.method).toBe('rule')
    // 判据必须能追到具体规则，而不是只有一句话
    expect(result.verdict.evidence[0]).toContain('intent.ignored-target')
    expect(ruleIds(result)).toContain('intent.ignored-target')
  })

  it('问题里的订单号在回答中消失 → 实体抽取遗漏', () => {
    const result = attribute(ENTITY_CASE)

    expect(result.verdict.category).toBe('entity_omission')
    expect(result.verdict.evidence[0]).toContain('entity.missing-question-slot')
    expect(result.verdict.evidence.join('')).toContain('20260501888')
  })

  it('编造法条 + 绝对化断言 → 逻辑幻觉，且分数累加后置信度封顶 0.9', () => {
    const result = attribute(HALLUCINATION_CASE)
    const ids = ruleIds(result)

    expect(result.verdict.category).toBe('logic_hallucination')
    expect(ids).toContain('hallucination.legal-citation')
    expect(ids).toContain('hallucination.absolute-assertion')
    // 两条命中累加超过 1，但规则引擎不给"近乎确定"的数字
    expect(result.scores.logic_hallucination).toBeCloseTo(1, 5)
    expect(result.verdict.confidence).toBe(0.9)
  })

  it('声称已执行处罚动作 → 逻辑幻觉', () => {
    const result = attribute({
      caseId: 'pun-1',
      question: '我要投诉快递员小李',
      modelAnswer: '已为您投诉，该快递员已被扣除当月全部工资并停职。',
    })

    expect(result.verdict.category).toBe('logic_hallucination')
    expect(ruleIds(result)).toContain('hallucination.punitive-action')
  })

  it('回答里的数字与期望冲突 → 逻辑幻觉（数字一致性规则）', () => {
    const result = attribute({
      caseId: 'num-1',
      question: '什么时候能到？',
      modelAnswer: '预计 3 天送达。',
      expected: '预计 5 天内送达',
    })

    expect(ruleIds(result)).toContain('hallucination.number-conflict')
    expect(result.verdict.category).toBe('logic_hallucination')
    expect(result.verdict.confidence).toBe(0.85)
  })

  it('问题是否定、回答给硬性肯定 → 意图识别偏差（否定翻转）', () => {
    const result = attribute({
      caseId: 'neg-1',
      question: '不要给我推优惠券，我只想查物流',
      modelAnswer: '当然可以，我们一定给您推荐最合适的优惠券！',
    })

    expect(result.verdict.category).toBe('intent_misunderstanding')
    expect(ruleIds(result)).toContain('intent.negation-flip')
  })
})

describe('规则引擎：阈值与打分策略', () => {
  it('分数低于阈值 → 未分类，并把原因写进判据（宁缺勿滥）', () => {
    const result = attribute(AMBIGUOUS_CASE)

    expect(result.verdict.category).toBe(UNCLASSIFIED)
    expect(result.verdict.method).toBe('rule')
    expect(result.verdict.evidence.at(-1)).toContain('低于阈值')
    // 未分类时建议是"人工抽检 + 回灌标注集"，不是某一个类别的套路
    expect(result.verdict.suggestion).toContain('人工抽检')
  })

  it('同一输入在不同阈值下结论不同（阈值是配置项，不是魔法数）', () => {
    const legalOnly: BadCase = {
      caseId: 'legal-1',
      question: '运费谁出？',
      modelAnswer: '根据《民法典》第五百条，退货运费由商家承担。',
    }

    const loose = attribute(legalOnly, { confidenceThreshold: 0.55 })
    const strict = attribute(legalOnly, { confidenceThreshold: 0.6 })

    expect(loose.verdict.category).toBe('logic_hallucination')
    expect(loose.verdict.confidence).toBe(0.55)
    expect(strict.verdict.category).toBe(UNCLASSIFIED)
  })

  it('两个维度同分时按严重度取：幻觉 > 实体 > 意图', () => {
    const tie: BadCase = {
      caseId: 'tie-1',
      question: '订单什么时候到？',
      modelAnswer: '好的，您的订单物流一律正常，请放心等待。',
    }

    const result = attribute(tie, { confidenceThreshold: 0.4 })

    expect(result.scores.logic_hallucination).toBeCloseTo(0.45, 5)
    expect(result.scores.entity_omission).toBeCloseTo(0.45, 5)
    expect(result.verdict.category).toBe('logic_hallucination')
  })

  it('判定是纯函数：同样的输入两次调用结果完全一致', () => {
    const first = attribute(ENTITY_CASE)
    const second = attribute(ENTITY_CASE)

    expect(first).toEqual(second)
  })
})

describe('规则引擎：自定义词表', () => {
  it('命中业务关键词会记在 hits 里，且支持用中文标签当 key', () => {
    const result = attributeWithRules(AMBIGUOUS_CASE, {
      confidenceThreshold: 0.55,
      extraKeywords: { 逻辑幻觉: ['发票中心'] },
    })

    expect(ruleIds(result)).toContain('custom.logic_hallucination')
    expect(result.scores.logic_hallucination).toBe(0.4)
    // 0.4 仍低于阈值：自定义词表不会因为"命中过"就强行定类
    expect(result.verdict.category).toBe(UNCLASSIFIED)
  })

  it('支持用类别 key 当 key，并可与内置规则叠加', () => {
    const result = attributeWithRules(INTENT_CASE, {
      confidenceThreshold: 0.55,
      extraKeywords: { intent_misunderstanding: ['花呗'] },
    })

    expect(ruleIds(result)).toContain('custom.intent_misunderstanding')
    expect(result.scores.intent_misunderstanding).toBeGreaterThan(0.55)
    expect(result.verdict.category).toBe('intent_misunderstanding')
  })
})

describe('实体抽取', () => {
  it('能抽出单号、手机号、400 电话、邮箱与引号内内容', () => {
    const entities = extractEntities(
      '订单 20260501888，客服 400-800-1234，手机 13800138000，邮箱 a.b@c.com，备注「加急」',
    )

    expect(entities).toEqual(expect.arrayContaining([
      '20260501888',
      '400-800-1234',
      '13800138000',
      'a.b@c.com',
      '加急',
    ]))
  })

  it('空文本返回空数组，重复实体去重', () => {
    expect(extractEntities('')).toEqual([])
    expect(extractEntities('订单 20260501888 和 20260501888')).toEqual(['20260501888'])
  })
})

describe('判据与建议的质量（可解释性）', () => {
  it('已分类的用例：建议里带具体规则信号，且不是空话', () => {
    const result = attribute(HALLUCINATION_CASE)

    expect(result.verdict.suggestion).toContain('命中信号')
    expect(result.verdict.suggestion).toContain('建议')
    expect(result.verdict.evidence.length).toBeGreaterThan(0)
    expect(result.verdict.evidence.every(item => item.startsWith('['))).toBe(true)
  })

  it('置信度始终落在 [0, 0.9] 区间内', () => {
    for (const badCase of [INTENT_CASE, ENTITY_CASE, HALLUCINATION_CASE, AMBIGUOUS_CASE]) {
      const { confidence } = attribute(badCase).verdict
      expect(confidence).toBeGreaterThanOrEqual(0)
      expect(confidence).toBeLessThanOrEqual(0.9)
    }
  })
})
