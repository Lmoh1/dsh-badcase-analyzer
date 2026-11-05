/**
 * `badcase_analyze` 工具定义。
 *
 * 职责边界（很重要，别让工具层长胖）：
 * - 本文件负责：入参/输出**契约**、输入归一化、报告汇总、模型可见文本渲染、UI 卡片投影、
 *   报告落盘；
 * - 归因逻辑不在这里：`attributeCases()`（`src/attribution/`）负责规则引擎与 LLM 的策略编排，
 *   本文件只是把配置、`ctx.llm` 与取消信号递进去。
 *
 * 关键 DSH 约定（详见 DSH《工具编写参考》）：
 * - `execute()` 只返回 `output.schema` 声明的**规范值**（无损 JSON），不要自己拼内容块；
 * - `output.render()` 把它转成模型可见内容；`output.presentationMeta()` 投影出 UI 卡片要用的
 *   可回放 JSON（会持久化在 `tool/result` 的 `meta` 上）；
 * - `presentCall` / `presentResult` 必须是纯函数（流式与回放都会调用）；
 * - 基础设施故障请抛异常，领域内的"不理想结果"写进规范值。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { ATTRIBUTION_STRATEGIES } from '../config.ts'
import type { Config as BadCaseAnalyzerConfig } from '../config.ts'
import { attributeCases } from '../attribution/index.ts'
import {
  ATTRIBUTION_CATEGORY_KEYS,
  ATTRIBUTION_CATEGORY_SPECS,
  UNCLASSIFIED,
} from '../attribution/types.ts'
import type {
  AnalyzedCase,
  AttributionCategoryKey,
  AttributionStrategy,
  BadCase,
} from '../attribution/types.ts'

/** 工具名：模型与 PTC mode 都通过这个名字调用。改名字属于破坏性变更。 */
export const TOOL_NAME = 'badcase_analyze'

/** 报告 schema 版本：报告结构变更时递增，便于下游按版本解析历史报告。 */
export const REPORT_VERSION = '1.0.0'

// 归因类别的定义与数据模型已下沉到 `src/attribution/types.ts`（归因层的单一事实来源），
// 这里重新导出，保持"从工具模块也能拿到这些常量"的旧用法可用。
export {
  ATTRIBUTION_CATEGORY_KEYS,
  ATTRIBUTION_CATEGORY_LABELS,
  ATTRIBUTION_CATEGORY_SPECS,
  ATTRIBUTION_STRATEGIES,
  UNCLASSIFIED,
} from '../attribution/types.ts'
export type {
  AnalyzedCase,
  AttributionCategoryKey,
  AttributionMethod,
  AttributionStrategy,
  AttributionVerdict,
  BadCase,
} from '../attribution/types.ts'

// #region 输入与报告的数据模型

/** 被跳过的条目（已通过 / 字段缺失 / 超上限 / 被过滤）。 */
export interface SkippedCase {
  caseId: string
  reason: string
}

/** 输入归一化的结果。 */
export interface LoadedCases {
  sourceKind: 'file' | 'inline'
  /** 文件绝对路径，或 `inline:<条数>`。 */
  sourceLabel: string
  /** 原始条目总数（含通过用例）。 */
  total: number
  /** 待分析的失败用例。 */
  cases: BadCase[]
  skipped: SkippedCase[]
}

/** 单个类别的统计。 */
export interface ReportCategoryStat {
  key: AttributionCategoryKey
  label: string
  count: number
  /** 占已分析条数的比例（0~1，保留三位小数）。 */
  ratio: number
}

/** 报告汇总。 */
export interface ReportSummary {
  /** 进入归因流程的失败用例数。 */
  total: number
  /** 成功给出归因结论的条数。 */
  analyzed: number
  /** 被跳过（已通过/字段缺失/超上限/被过滤）的条数。 */
  skipped: number
  /** 落在未分类兜底桶的条数。 */
  unclassified: number
  byCategory: ReportCategoryStat[]
}

/** 数据来源描述。 */
export interface ReportSource {
  kind: 'file' | 'inline'
  label: string
  /** 原始条目总数（含通过用例）。 */
  total: number
}

/** 结构化 JSON 报告（= 工具的规范输出值）。 */
export interface BadCaseReport {
  reportVersion: string
  generatedAt: string
  strategy: AttributionStrategy
  source: ReportSource
  summary: ReportSummary
  /** 报告落盘路径；`writeFile: false` 时该字段不存在。 */
  reportPath?: string
  cases: AnalyzedCase[]
}

// #endregion

// #region 输入归一化

/**
 * 字段别名表。
 * 每个评测框架的字段名都不一样，这里把常见别名收敛到规范字段，
 * 让插件不必要求用户先改数据格式。
 */
const FIELD_ALIASES = {
  caseId: ['caseId', 'case_id', 'id', 'sampleId', 'sample_id'],
  question: ['question', 'query', 'input', 'prompt', 'utterance', 'userInput', 'user_input'],
  modelAnswer: ['modelAnswer', 'model_answer', 'answer', 'output', 'response', 'prediction', 'completion'],
  expected: ['expected', 'groundTruth', 'ground_truth', 'reference', 'gold', 'target', 'label'],
  pass: ['pass', 'passed', 'success', 'ok', 'isCorrect', 'is_correct'],
  status: ['status', 'result', 'verdict', 'state'],
  tags: ['tags', 'labels', 'categories', 'tag'],
} as const

/** 评测报告对象里可能承载用例数组的字段名（按优先级尝试）。 */
const REPORT_ARRAY_KEYS = ['results', 'cases', 'items', 'data', 'samples', 'records'] as const

/** 表示"通过"的状态字符串（小写比较）。 */
const PASSED_STATUSES = new Set(['pass', 'passed', 'success', 'succeed', 'succeeded', 'ok', 'correct', 'yes', 'true'])

/** 表示"失败"的状态字符串（小写比较）。 */
const FAILED_STATUSES = new Set(['fail', 'failed', 'failure', 'error', 'incorrect', 'wrong', 'no', 'false'])

/** 判断是否为普通对象（排除数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按别名取原始值；跳过 undefined / null，取第一个有值的字段。 */
function pickRaw(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 按别名取字符串；数字会被转成字符串，空白字符串视为缺失。 */
function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const raw = pickRaw(record, keys)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return undefined
}

/** 按别名取字符串数组；字符串会按常见分隔符切开，数组里也做 trim 与去空。 */
function pickStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const raw = pickRaw(record, keys)
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item.length > 0)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,;|]/)
      .map(item => item.trim())
      .filter(item => item.length > 0)
  }
  return []
}

/**
 * 判定一条用例是否通过。
 * 缺省视为**失败**：本工具只分析 Bad Case，宁可多分析一条也不要漏。
 */
function isCasePassed(record: Record<string, unknown>): boolean {
  const explicit = pickRaw(record, FIELD_ALIASES.pass)
  if (typeof explicit === 'boolean') return explicit
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit >= 1
  if (typeof explicit === 'string') {
    const value = explicit.trim().toLowerCase()
    if (PASSED_STATUSES.has(value)) return true
    if (FAILED_STATUSES.has(value)) return false
  }
  const status = pickString(record, FIELD_ALIASES.status)
  if (status !== undefined) {
    const value = status.toLowerCase()
    if (PASSED_STATUSES.has(value)) return true
    if (FAILED_STATUSES.has(value)) return false
  }
  return false
}

/** 从解析后的 JSON 里取出用例数组：顶层数组，或报告对象中的已知数组字段。 */
function extractCaseArray(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (isRecord(parsed)) {
    for (const key of REPORT_ARRAY_KEYS) {
      const value = parsed[key]
      if (Array.isArray(value)) return value
    }
  }
  throw new Error(
    '输入里找不到用例数组：期望顶层是数组，或是一个包含 results / cases / items / data / samples / records 字段的对象。',
  )
}

/** 把 Error / 任意抛出物转成可读文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 相对路径按 DSH 进程工作目录解析。 */
function resolveInputPath(input: string, cwd: string): string {
  // TODO(校验): 目前用进程工作目录解析相对路径。DSH 有专门的 workspace / fs 服务负责
  // 工作目录与沙箱授权；若要让本工具在沙箱内也能正确解析/读写，应改为注入并使用该服务。
  return isAbsolute(input) ? input : resolve(cwd, input)
}

/** `loadBadCases` 的可选项。 */
export interface LoadBadCasesOptions {
  /** 解析相对路径用的工作目录。 */
  cwd: string
  /** 最多保留多少条失败用例。 */
  maxCases: number
  /** 只分析这些 caseId（可选）。 */
  caseIds?: readonly string[]
  /** 取消信号（转发自 `exec.signal`）。 */
  signal?: AbortSignal
}

/**
 * 读取并归一化输入。
 * @param source - JSON 文件路径，或直接传入的用例数组（也可以是评测报告对象转成的数组）。
 * @param options - 工作目录、条数上限、caseId 过滤、取消信号。
 * @returns 待分析用例 + 被跳过条目 + 来源信息。
 */
export async function loadBadCases(
  source: string | readonly unknown[],
  options: LoadBadCasesOptions,
): Promise<LoadedCases> {
  options.signal?.throwIfAborted()

  let raw: readonly unknown[]
  let sourceKind: 'file' | 'inline'
  let sourceLabel: string

  if (typeof source === 'string') {
    const filePath = resolveInputPath(source, options.cwd)
    sourceKind = 'file'
    sourceLabel = filePath
    // 用标准 Node.js fs 读取：读文件是纯基础设施动作，直接传给 LLM/工具层没必要。
    const text = await readFile(filePath, { encoding: 'utf8', signal: options.signal })
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      throw new Error(`解析评测结果 JSON 失败（${filePath}）：${errorMessage(error)}`)
    }
    raw = extractCaseArray(parsed)
  } else {
    sourceKind = 'inline'
    sourceLabel = `inline:${source.length}`
    raw = source
  }

  const filter = options.caseIds !== undefined && options.caseIds.length > 0
    ? new Set(options.caseIds)
    : undefined

  const cases: BadCase[] = []
  const skipped: SkippedCase[] = []

  for (const [index, entry] of raw.entries()) {
    const fallbackId = `case-${index + 1}`
    if (!isRecord(entry)) {
      skipped.push({ caseId: fallbackId, reason: '该条目不是对象，无法解析' })
      continue
    }

    const caseId = pickString(entry, FIELD_ALIASES.caseId) ?? fallbackId

    // 通过用例不进归因，但要计数，避免汇总里"少了几个"说不清。
    if (isCasePassed(entry)) {
      skipped.push({ caseId, reason: '用例已通过（pass），未进入归因' })
      continue
    }

    const question = pickString(entry, FIELD_ALIASES.question)
    const modelAnswer = pickString(entry, FIELD_ALIASES.modelAnswer)
    if (question === undefined || modelAnswer === undefined) {
      skipped.push({ caseId, reason: '缺少 question 或 modelAnswer 字段，无法归因' })
      continue
    }

    if (filter !== undefined && !filter.has(caseId)) {
      skipped.push({ caseId, reason: '被 caseIds 过滤条件排除' })
      continue
    }

    if (cases.length >= options.maxCases) {
      skipped.push({ caseId, reason: `超过 maxCases=${options.maxCases} 上限，本次未分析` })
      continue
    }

    const expected = pickString(entry, FIELD_ALIASES.expected)
    const tags = pickStringArray(entry, FIELD_ALIASES.tags)

    cases.push({
      caseId,
      question,
      modelAnswer,
      // exactOptionalPropertyTypes 下不能把 undefined 赋给可选属性，用条件展开。
      ...expected !== undefined ? { expected } : {},
      ...tags.length > 0 ? { tags } : {},
    })
  }

  return { sourceKind, sourceLabel, total: raw.length, cases, skipped }
}

// #endregion


// #region 报告构造与渲染

/** 保留三位小数，避免报告里出现 0.30000000000000004。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 按固定三维度顺序统计；未分类单独计数，不进三大类。 */
function buildCategoryStats(cases: readonly AnalyzedCase[]): ReportCategoryStat[] {
  const analyzed = cases.length
  return ATTRIBUTION_CATEGORY_SPECS.map((spec) => {
    const count = cases.filter(item => item.category === spec.key).length
    return {
      key: spec.key,
      label: spec.label,
      count,
      ratio: analyzed === 0 ? 0 : round3(count / analyzed),
    }
  })
}

/** 汇总 + 报告组装。 */
function buildReport(params: {
  strategy: AttributionStrategy
  loaded: LoadedCases
  analyzed: readonly AnalyzedCase[]
}): BadCaseReport {
  const { strategy, loaded, analyzed } = params
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    strategy,
    source: { kind: loaded.sourceKind, label: loaded.sourceLabel, total: loaded.total },
    summary: {
      total: analyzed.length,
      analyzed: analyzed.length,
      skipped: loaded.skipped.length,
      unclassified: analyzed.filter(item => item.category === UNCLASSIFIED).length,
      byCategory: buildCategoryStats(analyzed),
    },
    cases: [...analyzed],
  }
}

/** 截断长文本，避免把整段回答塞进模型可见文本。 */
function ellipsis(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`
}

/** 一行汇总，模型文本与 UI 卡片共用。 */
function formatSummaryHeadline(summary: ReportSummary): string {
  const parts = summary.byCategory
    .filter(item => item.count > 0)
    .map(item => `${item.label} ${item.count} 条（${Math.round(item.ratio * 100)}%）`)
  const unclassified = summary.unclassified > 0 ? ` ｜ 未分类 ${summary.unclassified} 条` : ''
  return `共分析 ${summary.analyzed} 条失败用例：${parts.length > 0 ? parts.join(' ｜ ') : '三类均未命中'}${unclassified}`
}

/**
 * 生成模型可见文本。
 * 模型看到的是"汇总 + 少量明细"，完整结构化结果通过规范值返回（PTC mode 可直接当对象用）。
 */
export function renderReportText(report: BadCaseReport, maxDetailLines: number, includeEvidence: boolean): string {
  const lines: string[] = []
  lines.push(`# Bad Case 归因分析报告（策略：${report.strategy}）`)
  lines.push('')
  lines.push(formatSummaryHeadline(report.summary))
  lines.push(
    `跳过 ${report.summary.skipped} 条（已通过 / 字段缺失 / 超上限 / 被 caseIds 过滤）`
      + `｜原始条目 ${report.source.total} 条｜来源：${report.source.label}`,
  )

  if (report.reportPath !== undefined) {
    lines.push(`报告文件：${report.reportPath}`)
  }

  const detail = report.cases.slice(0, Math.max(0, maxDetailLines))
  if (detail.length > 0) {
    lines.push('')
    lines.push(`## 明细（前 ${detail.length} 条，完整明细见 JSON 报告的 cases 字段）`)
    detail.forEach((item, index) => {
      lines.push(
        `${index + 1}. [${item.caseId}] ${item.categoryLabel}`
          + `（置信度 ${item.confidence}，来源 ${item.method}）`,
      )
      lines.push(`   问：${ellipsis(item.question, 120)}`)
      lines.push(`   答：${ellipsis(item.modelAnswer, 160)}`)
      if (includeEvidence && item.evidence.length > 0) {
        lines.push(`   判据：${ellipsis(item.evidence.join('；'), 200)}`)
      }
      lines.push(`   建议：${ellipsis(item.suggestion, 200)}`)
    })
  }

  if (report.cases.length > detail.length) {
    lines.push('')
    lines.push(`（另有 ${report.cases.length - detail.length} 条未在文本中展开）`)
  }

  return lines.join('\n')
}

/** UI 卡片用的紧凑汇总（`presentationMeta` 的投影形状）。 */
interface CardSummary {
  total: number
  skipped: number
  unclassified: number
  byCategory: { key: string; label: string; count: number }[]
  reportPath?: string
}

/** 从持久化的 `meta` 里还原卡片汇总；形状不对就返回 undefined（回退通用卡片）。 */
function readCardSummary(meta: unknown): CardSummary | undefined {
  if (!isRecord(meta)) return undefined
  const total = meta.total
  const skipped = meta.skipped
  const unclassified = meta.unclassified
  if (typeof total !== 'number' || typeof skipped !== 'number' || typeof unclassified !== 'number') {
    return undefined
  }
  const rawCategories = meta.byCategory
  const byCategory: CardSummary['byCategory'] = []
  if (Array.isArray(rawCategories)) {
    for (const entry of rawCategories) {
      if (!isRecord(entry)) continue
      const { key, label, count } = entry
      if (typeof key === 'string' && typeof label === 'string' && typeof count === 'number') {
        byCategory.push({ key, label, count })
      }
    }
  }
  const reportPath = typeof meta.reportPath === 'string' ? meta.reportPath : undefined
  return {
    total,
    skipped,
    unclassified,
    byCategory,
    ...reportPath !== undefined ? { reportPath } : {},
  }
}

/** 卡片上展示的一行汇总。 */
function formatCardLine(summary: CardSummary): string {
  const parts = summary.byCategory
    .filter(item => item.count > 0)
    .map(item => `${item.label} ${item.count} 条`)
  const unclassified = summary.unclassified > 0 ? ` ｜ 未分类 ${summary.unclassified} 条` : ''
  const skipped = summary.skipped > 0 ? ` ｜ 跳过 ${summary.skipped} 条` : ''
  const headline = parts.length > 0 ? parts.join(' ｜ ') : '三类均未命中'
  const path = summary.reportPath !== undefined ? `\n报告：${summary.reportPath}` : ''
  return `共分析 ${summary.total} 条：${headline}${unclassified}${skipped}${path}`
}

/** 卡片标题里对数据源的简短描述。 */
function describeSource(source: string | readonly unknown[]): string {
  if (typeof source === 'string') return source
  return `内联数组（${source.length} 条）`
}

// #endregion

// #region 工具定义

/** 工具依赖：上下文 + 插件配置。 */
export interface BadcaseAnalyzeToolDeps {
  ctx: Context
  config: BadCaseAnalyzerConfig
}

/**
 * 构造 `badcase_analyze` 工具定义（注册由 `apply` 完成）。
 *
 * 注册即副作用：插件被卸载（dispose）时工具自动注销，不需要手动清理。
 *
 * @param deps - Cordis 上下文与插件配置。
 * @returns 可直接交给 `ctx.tools.register()` 的工具定义。
 */
export function badcaseAnalyzeTool(deps: BadcaseAnalyzeToolDeps): ToolDefinition {
  const { ctx, config } = deps

  return defineTool({
    name: TOOL_NAME,
    description:
      '对评测跑出来的失败用例（Bad Case）做归因分析，输出结构化 JSON 报告。'
      + '每条失败用例会被归到三个固定维度之一：意图识别偏差 / 实体抽取遗漏 / 逻辑幻觉，'
      + '并给出判据与改进建议。'
      + '输入可以是包含评测结果的 JSON 文件路径，或直接传入用例数组。'
      + '用例对象至少需要 question（或 query/input/prompt）与模型回答（answer/output/response 之一），'
      + 'pass/passed 为 true 的用例会被跳过。',

    parameters: {
      source: {
        required: true,
        title: 'Bad Case 数据源',
        description:
          '评测结果的 JSON 文件路径（相对工作目录或绝对路径），或直接传入的用例数组。'
          + '文件内容可以是用例数组，也可以是包含 results / cases / items / data 字段的报告对象。',
        // 文件路径 与 数组 是互斥的两支，用 oneOf 表达"恰好匹配一支"。
        oneOf: [
          {
            type: 'string',
            title: '文件路径',
            description: '例如 "examples/badcases.sample.json"',
          },
          {
            type: 'array',
            title: '内联数组',
            description: '每个元素是一条用例对象',
            items: { type: 'json' },
          },
        ],
      },
      strategy: {
        type: 'string',
        enum: ATTRIBUTION_STRATEGIES,
        description:
          '本次归因策略：rule（仅关键词规则，快且可复现）/ llm（仅大模型）/ '
          + 'rule-then-llm（规则优先，置信度不足再交给大模型）。缺省取插件配置。',
      },
      caseIds: {
        type: 'array',
        items: { type: 'string' },
        description: '只分析这些 caseId（可选，便于复验单条或抽样）。',
      },
      maxCases: {
        type: 'integer',
        description: '本次最多分析多少条失败用例，缺省取插件配置 maxCases。',
      },
      persistReport: {
        type: 'boolean',
        description: '是否把完整 JSON 报告写入磁盘，缺省取插件配置 report.writeFile。',
      },
      outputPath: {
        type: 'string',
        description: '报告输出路径，缺省取插件配置 report.outputPath。',
      },
    },

    output: {
      // 规范输出：一份可直接入库/对比的报告对象。根是严格对象（additionalProperties: false），
      // 因为下游会按字段名消费它，多一个未知字段都说明契约漂移了。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reportVersion: { type: 'string', required: true, description: '报告 schema 版本' },
          generatedAt: { type: 'string', required: true, description: '生成时间（ISO 8601）' },
          strategy: {
            type: 'string',
            enum: ATTRIBUTION_STRATEGIES,
            required: true,
            description: '本次实际使用的归因策略',
          },
          source: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: '数据来源',
            properties: {
              kind: { type: 'string', enum: ['file', 'inline'], required: true },
              label: { type: 'string', required: true, description: '文件绝对路径或 inline:<条数>' },
              total: { type: 'integer', required: true, description: '原始条目总数（含通过用例）' },
            },
          },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: '汇总统计（卡片数据来源）',
            properties: {
              total: { type: 'integer', required: true },
              analyzed: { type: 'integer', required: true },
              skipped: { type: 'integer', required: true },
              unclassified: { type: 'integer', required: true },
              byCategory: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string', enum: ATTRIBUTION_CATEGORY_KEYS, required: true },
                    label: { type: 'string', required: true },
                    count: { type: 'integer', required: true },
                    ratio: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          reportPath: {
            type: 'string',
            description: '报告落盘路径；writeFile: false 时该字段不存在',
          },
          cases: {
            type: 'array',
            required: true,
            description: '逐条归因结果',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                caseId: { type: 'string', required: true },
                question: { type: 'string', required: true },
                modelAnswer: { type: 'string', required: true },
                expected: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                category: { type: 'string', enum: ATTRIBUTION_CATEGORY_KEYS, required: true },
                categoryLabel: { type: 'string', required: true },
                confidence: { type: 'number', required: true, description: '0~1' },
                method: {
                  type: 'string',
                  enum: ['rule', 'llm', 'fallback'],
                  required: true,
                  description: '归因来源',
                },
                evidence: { type: 'array', items: { type: 'string' }, required: true },
                suggestion: { type: 'string', required: true },
              },
            },
          },
        },
      },

      /** 模型可见内容：汇总 + 少量明细（完整明细在规范值里）。 */
      render: (_args, value) => {
        const text = renderReportText(value, config.report.maxDetailLines, config.report.includeEvidence)
        return [{ type: 'text', text }] satisfies ContentBlock[]
      },

      /**
       * UI 卡片投影：只留卡片需要的数字，避免把整份报告塞进会话日志。
       * 内置 Web Client 会把这段 JSON 持久化到 `tool/result` 的 `meta`，
       * Phase B 的自定义卡片（client 插件）可以直接按这个形状渲染。
       */
      presentationMeta: (_args, value) => ({
        total: value.summary.analyzed,
        skipped: value.summary.skipped,
        unclassified: value.summary.unclassified,
        byCategory: value.summary.byCategory.map(item => ({
          key: item.key,
          label: item.label,
          count: item.count,
        })),
        ...value.reportPath !== undefined ? { reportPath: value.reportPath } : {},
      }),
    },

    /** 待执行卡片：告诉用户正在分析什么（纯函数，只依赖入参）。 */
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `分析 Bad Case：${describeSource(args.source)}`,
      // 文件来源时标注位置，让有能力的编辑器跟随/跳转。
      ...typeof args.source === 'string' ? { locations: [{ path: args.source }] } : {},
    }),

    /** 完成卡片：用持久化的 meta 还原汇总行；形状异常则回退通用卡片。 */
    presentResult: (_args, result: ToolResult) => {
      if (result.isError) return undefined
      const summary = readCardSummary(result.meta)
      if (summary === undefined) return undefined
      return {
        card: 'generic',
        title: `Bad Case 归因汇总：共 ${summary.total} 条`,
        content: [{ type: 'text', text: formatCardLine(summary) }],
      }
    },

    /**
     * 工具主体：只返回规范值。
     * 基础设施故障（读文件失败、写报告失败）直接抛异常 —— 那属于 isError；
     * "有 Case 未分类""有 Case 被跳过"是正常的领域结果，写进规范值。
     */
    async execute(args, exec: ToolRunContext) {
      const strategy = args.strategy ?? config.strategy
      const maxCases = args.maxCases ?? config.maxCases
      // TODO(校验): 相对路径目前按进程工作目录解析；接入 DSH workspace/fs 服务后改为走服务。
      const cwd = process.cwd()

      const loaded = await loadBadCases(args.source, {
        cwd,
        maxCases,
        signal: exec.signal,
        ...args.caseIds !== undefined && args.caseIds.length > 0 ? { caseIds: args.caseIds } : {},
      })

      // 归因编排交给 attribution 层：这里只负责把配置/服务/取消信号递进去。
      // `ctx.llm` 结构上满足 LlmStreamer（只有 stream() 一个方法被用到）。
      const analyzed = await attributeCases(loaded.cases, {
        strategy,
        rules: {
          confidenceThreshold: config.rules.confidenceThreshold,
          extraKeywords: config.rules.extraKeywords,
        },
        llm: {
          provider: config.llm.provider,
          model: config.llm.model,
          temperature: config.llm.temperature,
          maxOutputTokens: config.llm.maxOutputTokens,
          timeoutMs: config.llm.timeoutMs,
        },
        fallbackToRules: config.llm.fallbackToRules,
        llmStreamer: ctx.llm,
        signal: exec.signal,
      })

      const report = buildReport({ strategy, loaded, analyzed })

      const shouldPersist = args.persistReport ?? config.report.writeFile
      if (!shouldPersist) return report

      const target = args.outputPath ?? config.report.outputPath
      const absoluteTarget = isAbsolute(target) ? target : resolve(cwd, target)
      const payload = `${JSON.stringify(report, null, 2)}\n`
      await mkdir(dirname(absoluteTarget), { recursive: true })
      await writeFile(absoluteTarget, payload, { encoding: 'utf8', signal: exec.signal })

      // 规范值里补上落盘路径，报告本身仍然是同一份只读快照。
      return { ...report, reportPath: absoluteTarget }
    },
  })
}

// #endregion
