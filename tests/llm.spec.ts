import { describe, expect, it } from 'vitest'

import {
  ATTRIBUTION_SYSTEM_PROMPT,
  LlmAttributionError,
  attributeWithLlm,
  buildAttributionUserPrompt,
  parseAttributionReply,
} from '../src/attribution/llm.ts'
import type { LlmCallSettings } from '../src/attribution/llm.ts'
import type { BadCase } from '../src/attribution/types.ts'
import {
  INTENT_CASE,
  LLM_REPLY_OK,
  createBlockOnlyLlm,
  createEmptyLlm,
  createFakeLlm,
  createTruncatingLlm,
} from './support/fakes.ts'

/** 测试用模型参数（timeoutMs 取小值，避免测试结束时残留长定时器）。 */
const SETTINGS: LlmCallSettings = {
  provider: 'test-provider',
  model: 'test-model',
  temperature: 0,
  maxOutputTokens: 256,
  timeoutMs: 1_000,
}

/** 捕获同步异常。 */
function captureError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

/** 捕获异步异常。 */
async function captureAsyncError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

/** 断言拿到的是带指定错误码的 LlmAttributionError。 */
function expectFailureCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LlmAttributionError)
  expect((error as LlmAttributionError).code).toBe(code)
}

describe('提示词构造', () => {
  it('用户提示词带完整三元组、标签与输出约束', () => {
    const prompt = buildAttributionUserPrompt(INTENT_CASE)

    expect(prompt).toContain('【Case ID】cs-001')
    expect(prompt).toContain(`【用户问题】${INTENT_CASE.question}`)
    expect(prompt).toContain('【模型回答】')
    expect(prompt).toContain(`【期望回答】${INTENT_CASE.expected ?? ''}`)
    expect(prompt).toContain('【评测标签】refund、multi-turn')
    expect(prompt).toContain('只输出一个 JSON 对象')
  })

  it('没有期望答案时明确标注"未提供"，不让模型猜', () => {
    const prompt = buildAttributionUserPrompt({ caseId: 'x', question: 'q', modelAnswer: 'a' })

    expect(prompt).toContain('（未提供）')
  })

  it('系统提示词写死了三个类别 key 与 JSON 契约', () => {
    expect(ATTRIBUTION_SYSTEM_PROMPT).toContain('intent_misunderstanding（意图识别偏差）')
    expect(ATTRIBUTION_SYSTEM_PROMPT).toContain('entity_omission（实体抽取遗漏）')
    expect(ATTRIBUTION_SYSTEM_PROMPT).toContain('logic_hallucination（逻辑幻觉）')
    expect(ATTRIBUTION_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象')
    expect(ATTRIBUTION_SYSTEM_PROMPT).toContain('"category"')
  })
})

describe('回复解析：宽容输入，严格校验', () => {
  it('标准 JSON 直接解析', () => {
    const verdict = parseAttributionReply(LLM_REPLY_OK)

    expect(verdict.category).toBe('entity_omission')
    expect(verdict.confidence).toBe(0.8)
    expect(verdict.method).toBe('llm')
    expect(verdict.evidence).toEqual(['回答没有覆盖期望答案要求的抬头信息'])
    expect(verdict.suggestion).toBe('补齐发票抬头与企业信息')
  })

  it('容忍 markdown 代码块与前后废话', () => {
    const fenced = `好的，我的判断如下：\n\`\`\`json\n${LLM_REPLY_OK}\n\`\`\`\n希望有帮助。`
    expect(parseAttributionReply(fenced).category).toBe('entity_omission')
  })

  it('类别写成中文标签也能认（不为一个字段名重试一次调用）', () => {
    const verdict = parseAttributionReply('{"category":"逻辑幻觉","confidence":0.7}')

    expect(verdict.category).toBe('logic_hallucination')
  })

  it('confidence 越界会被夹到 [0, 1]', () => {
    expect(parseAttributionReply('{"category":"logic_hallucination","confidence":1.7}').confidence).toBe(1)
    expect(parseAttributionReply('{"category":"logic_hallucination","confidence":-3}').confidence).toBe(0)
    expect(parseAttributionReply('{"category":"logic_hallucination"}').confidence).toBe(0.6)
  })

  it('判据缺失时给占位、建议缺失时用类别套路兜底', () => {
    const verdict = parseAttributionReply('{"category":"intent_misunderstanding","confidence":0.5}')

    expect(verdict.evidence).toEqual(['（模型未给出判据）'])
    expect(verdict.suggestion).toContain('建议：')
  })

  it('类别不在三大类内 → LLM_BAD_CATEGORY', () => {
    const error = captureError(() => parseAttributionReply('{"category":"完全不存在的类别"}'))
    expectFailureCode(error, 'LLM_BAD_CATEGORY')
  })

  it('根本不是 JSON → LLM_BAD_JSON', () => {
    const error = captureError(() => parseAttributionReply('我觉得是意图问题吧'))
    expectFailureCode(error, 'LLM_BAD_JSON')
  })

  it('JSON 根不是对象 → LLM_BAD_JSON', () => {
    const error = captureError(() => parseAttributionReply('[1, 2, 3]'))
    expectFailureCode(error, 'LLM_BAD_JSON')
  })
})

describe('LLM 归因调用', () => {
  it('把模型参数与提示词真的传下去，并返回解析后的结论', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)

    const verdict = await attributeWithLlm(INTENT_CASE, { llm, settings: SETTINGS })

    expect(verdict.category).toBe('entity_omission')
    expect(llm.callCount).toBe(1)
    const call = llm.calls[0]
    expect(call?.provider).toBe('test-provider')
    expect(call?.model).toBe('test-model')
    expect(call?.temperature).toBe(0)
    expect(call?.maxTokens).toBe(256)
    expect(call?.system).toBe(ATTRIBUTION_SYSTEM_PROMPT)
    expect(call?.userPrompt).toContain('【Case ID】cs-001')
  })

  it('首次输出不是 JSON 时自动重试一次，并追加更强约束', async () => {
    const llm = createFakeLlm(call => (call === 1 ? '我不太确定，可能是意图问题' : LLM_REPLY_OK))

    const verdict = await attributeWithLlm(INTENT_CASE, { llm, settings: SETTINGS })

    expect(verdict.category).toBe('entity_omission')
    expect(llm.callCount).toBe(2)
    expect(llm.calls[1]?.userPrompt).toContain('上一次回复无法解析')
  })

  it('maxAttempts=1 时不做重试，直接把解析错误抛出去', async () => {
    const llm = createFakeLlm('不是 JSON')

    const error = await captureAsyncError(() => attributeWithLlm(INTENT_CASE, {
      llm,
      settings: SETTINGS,
      maxAttempts: 1,
    }))

    expectFailureCode(error, 'LLM_BAD_JSON')
    expect(llm.callCount).toBe(1)
  })

  it('空回复重试后仍为空 → LLM_EMPTY_REPLY', async () => {
    const error = await captureAsyncError(() => attributeWithLlm(INTENT_CASE, {
      llm: createEmptyLlm(),
      settings: SETTINGS,
    }))

    expectFailureCode(error, 'LLM_EMPTY_REPLY')
  })

  it('输出被 max-tokens 截断 → LLM_TRUNCATED（不把半截 JSON 当结论）', async () => {
    const error = await captureAsyncError(() => attributeWithLlm(INTENT_CASE, {
      llm: createTruncatingLlm(),
      settings: SETTINGS,
    }))

    expectFailureCode(error, 'LLM_TRUNCATED')
  })

  it('finish 报错 → LLM_CALL_FAILED，并保留原始原因', async () => {
    const llm = createFakeLlm(new Error('模拟上游 500'))

    const error = await captureAsyncError(() => attributeWithLlm(INTENT_CASE, { llm, settings: SETTINGS }))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('模拟上游 500')
  })

  it('只发整块、不发增量的 adapter 也能被正确收集', async () => {
    const verdict = await attributeWithLlm(INTENT_CASE, {
      llm: createBlockOnlyLlm(LLM_REPLY_OK),
      settings: SETTINGS,
    })

    expect(verdict.category).toBe('entity_omission')
  })

  it('调用前已中止的信号不会发起任何请求', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)

    const error = await captureAsyncError(() => attributeWithLlm(INTENT_CASE, {
      llm,
      settings: SETTINGS,
      signal: AbortSignal.abort(),
    }))

    expect(error).toBeInstanceOf(Error)
    expect(llm.callCount).toBe(0)
  })

  it('每条用例独立构造消息（不会复用上一条的上下文）', async () => {
    const llm = createFakeLlm(LLM_REPLY_OK)
    const other: BadCase = { caseId: 'cs-999', question: '另一个问题', modelAnswer: '另一个回答' }

    await attributeWithLlm(INTENT_CASE, { llm, settings: SETTINGS })
    await attributeWithLlm(other, { llm, settings: SETTINGS })

    const [first, second] = llm.calls
    expect(first?.messages).toHaveLength(1)
    expect(second?.messages).toHaveLength(1)
    expect(second?.userPrompt).toContain('cs-999')
    expect(second?.userPrompt).not.toContain('cs-001')
  })
})
