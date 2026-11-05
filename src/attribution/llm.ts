/**
 * LLM 归因：把「问题 + 模型回答 + 期望答案」交给大模型，要求它只输出一个 JSON 结论。
 *
 * 关键工程点（比"调个 API"更重要的是这些）：
 * - **单次调用的形状**走 DSH 官方服务：`ctx.llm.stream({ provider, model, messages, system, ... })`，
 *   消息用 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造，source 标成 plugin；
 * - **输出必须先约束再解析**：系统提示词里写死 JSON 契约，解析侧做严格校验；
 * - **可失败**：调用失败/输出被截断/JSON 不合法都抛 `LlmAttributionError`，
 *   由上层 `index.ts` 决定"回退规则结果"还是"标记未分类"，而不是在这里假装成功；
 * - **可测试**：依赖注入的是一个结构化的 `LlmStreamer`（只要有 `stream()` 就够），
 *   所以 `scripts/smoke.mjs` 能用一个假流跑通整条 LLM 路径，**不需要真实 API Key**。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  ATTRIBUTION_CATEGORY_SPECS,
  defaultSuggestion,
  resolveCategoryKey,
} from './types.ts'
import type { AttributionVerdict, BadCase } from './types.ts'

// #region 依赖与错误类型

/**
 * LLM 服务的最小结构契约（DSH 的 `ctx.llm` 天然满足）。
 * 只声明用得到的一个方法，好处是测试里用假实现即可，不需要 mock 整个服务。
 */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 一次归因调用需要的模型参数（插件 `Config.llm` 的子集，结构兼容）。
 * 刻意不直接 import 插件配置类型：归因层不应依赖插件配置层。
 */
export interface LlmCallSettings {
  /** DSH provider 路由名。 */
  provider: string
  model: string
  temperature: number
  /** 输出 token 上限；太小会把 JSON 截断。 */
  maxOutputTokens: number
  /** 单次调用超时（毫秒）。 */
  timeoutMs: number
}

/** LLM 归因的失败原因。上层据此决定回退策略。 */
export type LlmAttributionFailureCode =
  | 'LLM_CALL_FAILED'
  | 'LLM_EMPTY_REPLY'
  | 'LLM_TRUNCATED'
  | 'LLM_BAD_JSON'
  | 'LLM_BAD_CATEGORY'

/** LLM 归因失败。属于"基础设施/解析失败"，不是领域结论。 */
export class LlmAttributionError extends Error {
  readonly code: LlmAttributionFailureCode

  constructor(message: string, code: LlmAttributionFailureCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmAttributionError'
    this.code = code
  }
}

// #endregion

// #region Prompt

/** 系统提示词：固定三个类别 + 判定顺序 + 输出 JSON 契约。 */
export const ATTRIBUTION_SYSTEM_PROMPT = [
  '你是 AI 产品效果评测的归因专家。用户会给你一条"模型回答错误"的评测用例，',
  '你要判断它错在哪个环节。',
  '',
  '只能从下面三个类别里选一个，category 必须原样使用英文 key：',
  ...ATTRIBUTION_CATEGORY_SPECS.map(
    (spec, index) => `${index + 1}. ${spec.key}（${spec.label}）：${spec.hint}`,
  ),
  '',
  '判定顺序（重要，按这个顺序看）：',
  '1. 先看回答的方向对不对得上用户的诉求；方向就错了 → 意图识别偏差。',
  '2. 方向对，但问题里的关键实体（订单号/时间/金额/商品/联系方式）没出现在回答里 → 实体抽取遗漏。',
  '3. 回答里出现了期望答案中不存在的事实断言（法条编号、政策细节、处罚动作、具体数字）→ 逻辑幻觉。',
  '4. 多个类别都沾边时，按严重度只取一个：逻辑幻觉 > 实体抽取遗漏 > 意图识别偏差。',
  '',
  '输出要求：',
  '- 只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释文字；',
  '- confidence 是 0~1 的小数，表示你对这个判断的把握；',
  '- evidence 是 1~3 条中文判据，必须引用回答或问题里的具体内容，不要空话；',
  '- suggestion 是一条可落地的改进建议（数据/提示词/检索/后处理方向）。',
  '',
  '输出格式：',
  '{"category":"intent_misunderstanding|entity_omission|logic_hallucination",'
    + '"confidence":0.0,"evidence":["..."],"suggestion":"..."}',
].join('\n')

/** 用户提示词：一条用例的三元组。 */
export function buildAttributionUserPrompt(badCase: BadCase): string {
  const lines = [
    `【Case ID】${badCase.caseId}`,
    `【用户问题】${badCase.question}`,
    `【模型回答】${badCase.modelAnswer}`,
    `【期望回答】${badCase.expected ?? '（未提供）'}`,
  ]
  if (badCase.tags !== undefined && badCase.tags.length > 0) {
    lines.push(`【评测标签】${badCase.tags.join('、')}`)
  }
  lines.push('', '请只输出一个 JSON 对象。')
  return lines.join('\n')
}

// #endregion

// #region 输出解析

/** 从模型回复里抠出第一个完整 JSON 对象（容忍 ```json 代码块与前后废话）。 */
function extractJsonObject(raw: string): string | undefined {
  const stripped = raw.replace(/```(?:json)?/gi, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  return stripped.slice(start, end + 1)
}

/**
 * 解析并校验模型的 JSON 回复。
 *
 * 校验点：类别必须是三个 key（也接受中文标签）、confidence 夹到 0~1、
 * evidence 只留字符串、suggestion 空了就用类别套路兜底。
 *
 * @param raw - 模型输出原文。
 * @returns 规范化后的归因结论（`method` 固定为 `llm`）。
 * @throws LlmAttributionError - 无法解析或类别非法时抛出，交由上层回退。
 */
export function parseAttributionReply(raw: string): AttributionVerdict {
  const jsonText = extractJsonObject(raw)
  if (jsonText === undefined) {
    throw new LlmAttributionError(`LLM 回复里找不到 JSON 对象：${preview(raw)}`, 'LLM_BAD_JSON')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch (error) {
    throw new LlmAttributionError(`LLM 回复不是合法 JSON：${preview(jsonText)}`, 'LLM_BAD_JSON', { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LlmAttributionError('LLM 回复的 JSON 根不是对象', 'LLM_BAD_JSON')
  }

  const record = parsed as Record<string, unknown>
  const category = resolveCategoryKey(record.category)
  if (category === undefined) {
    throw new LlmAttributionError(
      `LLM 给出的类别不合法：${String(record.category)}（应为三大类之一）`,
      'LLM_BAD_CATEGORY',
    )
  }

  const rawConfidence = typeof record.confidence === 'number' ? record.confidence : 0.6
  const confidence = Math.round(Math.min(1, Math.max(0, rawConfidence)) * 1000) / 1000

  const evidence = Array.isArray(record.evidence)
    ? record.evidence
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item.length > 0)
      .slice(0, 5)
    : []

  const suggestion = typeof record.suggestion === 'string' && record.suggestion.trim().length > 0
    ? record.suggestion.trim()
    : defaultSuggestion(category)

  return {
    category,
    confidence,
    evidence: evidence.length > 0 ? evidence : ['（模型未给出判据）'],
    suggestion,
    method: 'llm',
  }
}

/** 取回复前 160 字用于错误信息（避免把整段提示词/输出塞进日志）。 */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 160)}…`
}

// #endregion

// #region 单次调用

/** 归因调用的入参。 */
export interface LlmAttributeOptions {
  /** LLM 服务（DSH 里传 `ctx.llm`；测试里传假实现）。 */
  llm: LlmStreamer
  settings: LlmCallSettings
  /** 调用方取消信号（转发自工具的 `exec.signal`）。 */
  signal?: AbortSignal
  /**
   * 最大尝试次数（默认 2）。
   * 只在"回复无法解析/为空"时重试；网络/鉴权类失败直接抛，不浪费额度。
   */
  maxAttempts?: number
}

/** 一次调用收集到的文本。 */
interface CollectedReply {
  text: string
  /** 是否被 max-tokens 截断（截断的 JSON 一定解析失败，需要单独提示）。 */
  truncated: boolean
}

/** 合并"调用方取消"与"本地超时"两个信号。 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
}

/** 把 `LlmFailure` 之类的失败对象转成可读文本（结构不保证，故用宽松取值）。 */
function describeFailure(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null) {
    const message = (failure as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    try {
      return JSON.stringify(failure)
    } catch {
      return String(failure)
    }
  }
  return String(failure)
}

/** 发一次请求并收集可见文本。 */
async function collectReply(input: {
  llm: LlmStreamer
  settings: LlmCallSettings
  messages: Message[]
  signal: AbortSignal
}): Promise<CollectedReply> {
  let text = ''
  const blockTexts: string[] = []

  for await (const chunk of input.llm.stream({
    provider: input.settings.provider,
    model: input.settings.model,
    // 一次性调用：system 单独传（adapter 会映射到 provider 的 system 槽位）
    system: ATTRIBUTION_SYSTEM_PROMPT,
    messages: input.messages,
    temperature: input.settings.temperature,
    maxTokens: input.settings.maxOutputTokens,
    signal: input.signal,
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      // 有些 adapter 只发整块不发增量，这里兜底。
      blockTexts.push(chunk.block.text)
      continue
    }
    if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        throw new LlmAttributionError(
          `LLM 调用失败（${chunk.reason.kind}）：${describeFailure(chunk.reason.failure)}`,
          'LLM_CALL_FAILED',
        )
      }
      return {
        text: text.length > 0 ? text : blockTexts.join(''),
        truncated: chunk.reason.kind === 'max-tokens',
      }
    }
  }

  // 没有 finish 块（不该发生）：按已收到的内容处理。
  return { text: text.length > 0 ? text : blockTexts.join(''), truncated: false }
}

/**
 * 用 LLM 给一条失败用例归因。
 *
 * @param badCase - 归一化后的失败用例。
 * @param options - LLM 服务、模型参数、取消信号、最大尝试次数。
 * @returns 归因结论（`method: 'llm'`）。
 * @throws LlmAttributionError - 调用失败、输出截断、JSON/类别不合法时抛出。
 */
export async function attributeWithLlm(
  badCase: BadCase,
  options: LlmAttributeOptions,
): Promise<AttributionVerdict> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
  const signal = combineSignals(options.signal, options.settings.timeoutMs)
  const userPrompt = buildAttributionUserPrompt(badCase)

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal.throwIfAborted()

    // 第二次尝试追加一句强约束（模型偶尔会先输出一段解释）。
    const promptText = attempt === 1
      ? userPrompt
      : `${userPrompt}\n\n（上一次回复无法解析为 JSON，这次只输出一个 JSON 对象，不要任何解释或代码块。）`

    const messages: Message[] = [
      createUserMessage({
        source: { kind: 'plugin', plugin: 'badcase-analyzer' },
        content: [{ type: 'text', text: promptText }],
      }),
    ]

    const reply = await collectReply({
      llm: options.llm,
      settings: options.settings,
      messages,
      signal,
    })

    if (reply.truncated) {
      throw new LlmAttributionError(
        `LLM 输出被 max-tokens 截断（maxOutputTokens=${options.settings.maxOutputTokens}），`
          + '请调大 config.llm.maxOutputTokens 后重试',
        'LLM_TRUNCATED',
      )
    }

    if (reply.text.trim().length === 0) {
      lastError = new LlmAttributionError('LLM 返回空回复', 'LLM_EMPTY_REPLY')
      continue
    }

    try {
      return parseAttributionReply(reply.text)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new LlmAttributionError('LLM 归因失败（未知原因）', 'LLM_CALL_FAILED')
}

// #endregion
