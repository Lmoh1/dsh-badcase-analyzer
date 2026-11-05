/**
 * 测试替身与夹具。
 *
 * 这里能这么"轻"地替换掉大模型，是因为归因层只依赖一个结构化接口
 * `LlmStreamer`（只有 `stream()` 一个方法）——不需要 mock 框架内部对象、不需要真 API Key。
 * 这也是这一层值得写单测的直接原因。
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import type { LlmStreamer } from '../../src/attribution/llm.ts'
import type { BadCase } from '../../src/attribution/types.ts'

/** 一次假调用的记录，用来断言"参数真的传下去了"。 */
export interface FakeLlmCall {
  /** 第几次调用（从 1 开始）。 */
  call: number
  provider: string
  model: string
  temperature: number | undefined
  maxTokens: number | undefined
  system: string | undefined
  /** 用户提示词全文（第一条消息的可见文本）。 */
  userPrompt: string
  messages: GenerateOptions['messages']
}

/** 假 LLM 的脚本：固定文本 / 直接抛错 / 按调用序号决定。 */
export type FakeLlmScript = string | Error | ((call: number, options: GenerateOptions) => string | Error)

/** 带调用记录的假 LLM。 */
export interface FakeLlm extends LlmStreamer {
  readonly calls: FakeLlmCall[]
  readonly callCount: number
}

/** 取第一条消息里的可见文本。 */
function firstText(options: GenerateOptions): string {
  const message = options.messages[0]
  if (message === undefined) return ''
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

/**
 * 造一个只有 `stream()` 的假 LLM。
 * 文本按 20 字分片吐出，顺便覆盖"增量拼接"这条路径（JSON 会被切在中间）。
 */
export function createFakeLlm(script: FakeLlmScript): FakeLlm {
  const calls: FakeLlmCall[] = []

  const stream = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    const call = calls.length + 1
    calls.push({
      call,
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      system: options.system,
      userPrompt: firstText(options),
      messages: options.messages,
    })

    const step = typeof script === 'function' ? script(call, options) : script

    return (async function* generate(): AsyncGenerator<StreamChunk> {
      if (step instanceof Error) throw step
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (let index = 0; index < step.length; index += 20) {
        yield { type: 'text-delta', index: 0, text: step.slice(index, index + 20) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  return {
    calls,
    stream,
    get callCount(): number {
      return calls.length
    },
  }
}

/** 只发整块、不发增量的流：验证收集逻辑的兜底分支。 */
export function createBlockOnlyLlm(text: string): LlmStreamer {
  return {
    stream: () => (async function* generate(): AsyncGenerator<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
}

/** 什么都没吐就结束的流：触发空回复路径。 */
export function createEmptyLlm(): LlmStreamer {
  return {
    stream: () => (async function* generate(): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
}

/** 输出被 max-tokens 截断的流（JSON 一定是半截的）。 */
export function createTruncatingLlm(): LlmStreamer {
  return {
    stream: () => (async function* generate(): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"category":"logic_' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })(),
  }
}

/** 一次合法的 LLM 回复。 */
export const LLM_REPLY_OK = JSON.stringify({
  category: 'entity_omission',
  confidence: 0.8,
  evidence: ['回答没有覆盖期望答案要求的抬头信息'],
  suggestion: '补齐发票抬头与企业信息',
})

/** 归因规则能明确判定的用例：意图识别偏差。 */
export const INTENT_CASE: BadCase = {
  caseId: 'cs-001',
  question: '帮我把上周买的耳机退款，改成退到花呗',
  modelAnswer: '好的，已为您取消订单并全额退款到银行卡，预计 3 个工作日到账。',
  expected: '先澄清「退款到花呗」是否指退款原路返回，再确认订单号',
  tags: ['refund', 'multi-turn'],
}

/** 归因规则能明确判定的用例：实体抽取遗漏。 */
export const ENTITY_CASE: BadCase = {
  caseId: 'cs-003',
  question: '订单 20260501888 什么时候到？',
  modelAnswer: '您的订单预计明天送达，请耐心等待。',
  expected: '查询订单 20260501888 的物流状态并给出预计到达时间',
}

/** 归因规则能明确判定的用例：逻辑幻觉。 */
export const HALLUCINATION_CASE: BadCase = {
  caseId: 'cs-005',
  question: '退货运费谁承担？',
  modelAnswer: '根据《消费者权益保护法》第七百二十一条，退货运费一律由商家承担。',
  expected: '质量问题的退货运费由商家承担，非质量问题由买家承担',
}

/** 规则给不出高置信结论的用例（应当落到 unclassified，交给 LLM 或人工）。 */
export const AMBIGUOUS_CASE: BadCase = {
  caseId: 'cs-002',
  question: '你们这个会员能开发票吗？',
  modelAnswer: '可以的，在「我的-发票中心」申请即可。',
  expected: '说明可以在「我的-发票中心」申请电子发票，支持企业与个人抬头',
}

/** 四条覆盖四种归因结果的用例集合。 */
export const SAMPLE_CASES: readonly BadCase[] = [
  INTENT_CASE,
  ENTITY_CASE,
  HALLUCINATION_CASE,
  AMBIGUOUS_CASE,
]
