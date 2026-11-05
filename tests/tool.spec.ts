import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Config } from '../src/config.ts'
import type { Config as ConfigShape } from '../src/config.ts'
import { TOOL_NAME, badcaseAnalyzeTool, renderReportText } from '../src/tool/badcase-analyze.ts'
import { LLM_REPLY_OK, createFakeLlm } from './support/fakes.ts'

/** 测试用的"浅层覆盖"配置：可以只写一个子字段，其余交给 schema 默认值。 */
type ConfigPatch = { [K in keyof ConfigShape]?: Partial<ConfigShape[K]> }

/**
 * 工具契约测试：参数 schema、输出 schema、执行路径、报告落盘、卡片投影。
 *
 * 这里断言的是「注册表会对什么负责」，所以直接用 DSH 导出的
 * `validateJsonSchemaValue` 做校验 —— 和运行时走的是同一套校验器。
 */

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-badcase-tool-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** 用 schema 解析一份配置：只覆盖关心的字段，其余走默认值。 */
function resolveConfig(patch: ConfigPatch = {}): ConfigShape {
  return Config(patch as ConfigShape)
}

/** 假的工具执行上下文（只有取消信号被用到）。 */
function makeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

/** 造工具；ctx 用空对象即可（纯规则路径不会碰 ctx.llm）。 */
function makeTool(patch: ConfigPatch = {}, ctx: Context = {} as unknown as Context) {
  const config = resolveConfig(patch)
  return badcaseAnalyzeTool({ ctx, config })
}

/** 写一个评测报告夹具，返回绝对路径。 */
async function writeReportFixture(name: string, results: unknown[]): Promise<string> {
  const filePath = join(tempDir, name)
  await writeFile(filePath, JSON.stringify({ runId: 'test-run', results }), 'utf8')
  return filePath
}

const FAILED_CASES = [
  { caseId: 'cs-001', question: '帮我把上周买的耳机退款，改成退到花呗', modelAnswer: '已为您退款到银行卡。', pass: false },
  { caseId: 'cs-003', question: '订单 20260501888 什么时候到？', modelAnswer: '预计明天送达。', pass: false },
]
const PASSED_CASE = { caseId: 'cs-007', question: '客服电话多少？', modelAnswer: '400-800-1234', pass: true }

describe('工具定义与参数契约', () => {
  it('名字符合约定，描述里说明了输入与三种归因类别', () => {
    const tool = makeTool()

    expect(TOOL_NAME).toBe('badcase_analyze')
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.description).toContain('归因')
    expect(tool.description).toContain('意图识别偏差')
    expect(tool.description).toContain('实体抽取遗漏')
    expect(tool.description).toContain('逻辑幻觉')
  })

  it('source 必填，只接受文件路径或数组（oneOf 表达互斥）', () => {
    const parameters = makeTool().parameters as unknown as JsonSchemaNode

    expect(validateJsonSchemaValue(parameters, { source: 'a.json' }, '')).toEqual([])
    expect(validateJsonSchemaValue(parameters, { source: [{ caseId: 'a' }] }, '')).toEqual([])
    expect(validateJsonSchemaValue(parameters, {}, '')).not.toEqual([])
    expect(validateJsonSchemaValue(parameters, { source: 42 }, '')).not.toEqual([])
  })

  it('strategy 只接受三种枚举值', () => {
    const parameters = makeTool().parameters as unknown as JsonSchemaNode

    for (const strategy of ['rule', 'llm', 'rule-then-llm']) {
      expect(validateJsonSchemaValue(parameters, { source: 'a.json', strategy }, '')).toEqual([])
    }
    expect(validateJsonSchemaValue(parameters, { source: 'a.json', strategy: 'magic' }, '')).not.toEqual([])
  })
})

describe('执行路径', () => {
  it('文件输入 → 返回满足 output.schema 的报告', async () => {
    const filePath = await writeReportFixture('ok.json', [...FAILED_CASES, PASSED_CASE])
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())

    expect(validateJsonSchemaValue(tool.output.schema, value as never, '')).toEqual([])
    const report = value as { summary: Record<string, number>, source: { kind: string }, cases: unknown[] }
    expect(report.source.kind).toBe('file')
    expect(report.summary.total).toBe(2)
    expect(report.summary.analyzed).toBe(2)
    expect(report.summary.skipped).toBe(1)
    expect(report.cases).toHaveLength(2)
  })

  it('没有失败用例时报告依然合法（summary 全 0，不给假数据）', async () => {
    const filePath = await writeReportFixture('all-passed.json', [PASSED_CASE])
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())

    expect(validateJsonSchemaValue(tool.output.schema, value as never, '')).toEqual([])
    const report = value as { summary: { total: number, analyzed: number, byCategory: unknown[] }, cases: unknown[] }
    expect(report.summary.total).toBe(0)
    expect(report.summary.analyzed).toBe(0)
    expect(report.cases).toHaveLength(0)
    expect(report.summary.byCategory).toHaveLength(3)
  })

  it('persistReport: false 时不写盘，也没有 reportPath 字段', async () => {
    const filePath = await writeReportFixture('no-persist.json', FAILED_CASES)
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())

    expect('reportPath' in (value as Record<string, unknown>)).toBe(false)
  })

  it('persistReport: true 时落盘，且文件内容与规范值一致', async () => {
    const filePath = await writeReportFixture('persist.json', FAILED_CASES)
    const outputPath = join(tempDir, 'report.json')
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: true, outputPath }, makeExec())
    const written = JSON.parse(await readFile(outputPath, 'utf8')) as { cases: unknown[] }

    expect((value as { reportPath?: string }).reportPath).toBe(outputPath)
    expect(written.cases).toHaveLength(2)
  })

  it('入参 strategy 覆盖插件配置', async () => {
    const filePath = await writeReportFixture('override.json', FAILED_CASES)
    // 配置要求 llm 策略，但 ctx 里没有 llm 服务；入参强制 rule 才不会走 LLM 分支
    const tool = makeTool({ strategy: 'llm' })

    const value = await tool.execute({ source: filePath, strategy: 'rule', persistReport: false }, makeExec())
    const methods = (value as { cases: { method: string }[] }).cases.map(item => item.method)

    expect(methods).toEqual(['rule', 'rule'])
  })

  it('ctx.llm 存在时，llm 策略会真的调用模型', async () => {
    const filePath = await writeReportFixture('with-llm.json', FAILED_CASES)
    const llm = createFakeLlm(LLM_REPLY_OK)
    const tool = makeTool({ strategy: 'llm' }, { llm } as unknown as Context)

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())
    const methods = (value as { cases: { method: string }[] }).cases.map(item => item.method)

    expect(methods).toEqual(['llm', 'llm'])
    expect(llm.callCount).toBe(2)
  })

  it('maxCases 与 caseIds 在工具层同样生效', async () => {
    const filePath = await writeReportFixture('limits.json', [
      ...FAILED_CASES,
      { caseId: 'cs-004', question: '订单 12345678 到哪了', modelAnswer: '已发货', pass: false },
    ])
    const tool = makeTool()

    const capped = await tool.execute({ source: filePath, maxCases: 1, persistReport: false }, makeExec())
    expect((capped as { summary: { total: number, skipped: number } }).summary).toMatchObject({ total: 1, skipped: 2 })

    const filtered = await tool.execute(
      { source: filePath, caseIds: ['cs-003'], persistReport: false },
      makeExec(),
    )
    expect((filtered as { cases: { caseId: string }[] }).cases.map(item => item.caseId)).toEqual(['cs-003'])
  })

  it('输出契约是严格的：多一个字段就校验不过', async () => {
    const filePath = await writeReportFixture('strict.json', FAILED_CASES)
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())
    const withExtra = { ...(value as Record<string, unknown>), extraField: 1 }

    expect(validateJsonSchemaValue(tool.output.schema, value as never, '')).toEqual([])
    expect(validateJsonSchemaValue(tool.output.schema, withExtra as never, '')).not.toEqual([])
  })
})

describe('渲染与卡片投影', () => {
  it('presentationMeta 只给卡片需要的数字', async () => {
    const filePath = await writeReportFixture('meta.json', [...FAILED_CASES, PASSED_CASE])
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())
    const meta = tool.output.presentationMeta?.(undefined as never, value as never) as {
      total: number
      skipped: number
      byCategory: { key: string, count: number }[]
    }

    expect(meta.total).toBe(2)
    expect(meta.skipped).toBe(1)
    expect(meta.byCategory).toHaveLength(3)
    expect(meta.byCategory.map(item => item.key)).toEqual([
      'intent_misunderstanding',
      'entity_omission',
      'logic_hallucination',
    ])
  })

  it('presentCall：文件来源标注 locations，数组来源不标注', () => {
    const tool = makeTool()

    const fromFile = tool.presentCall?.({ source: '/tmp/result.json' })
    expect(fromFile).toMatchObject({ card: 'generic', kind: 'search' })
    expect(fromFile?.card === 'generic' ? fromFile.locations : undefined).toEqual([{ path: '/tmp/result.json' }])

    const fromArray = tool.presentCall?.({ source: [{ caseId: 'a' }, { caseId: 'b' }] })
    expect(fromArray).not.toHaveProperty('locations')
    expect(fromArray?.card === 'generic' ? fromArray.title : '').toContain('内联数组')
  })

  it('presentResult：正常回卡片；出错或 meta 异常则回退通用卡片', async () => {
    const filePath = await writeReportFixture('card.json', FAILED_CASES)
    const tool = makeTool()

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())
    const meta = tool.output.presentationMeta?.(undefined as never, value as never)
    const okResult: ToolResult = { content: [], isError: false, ...meta !== undefined ? { meta } : {} }

    const card = tool.presentResult?.({ source: filePath }, okResult)
    expect(card).toMatchObject({ card: 'generic' })
    expect(card?.card === 'generic' ? card.title : '').toContain('归因汇总')

    expect(tool.presentResult?.({ source: filePath }, { ...okResult, isError: true })).toBeUndefined()
    expect(tool.presentResult?.({ source: filePath }, { content: [], isError: false })).toBeUndefined()
    expect(
      tool.presentResult?.({ source: filePath }, {
        content: [],
        isError: false,
        meta: { total: '不是数字' } as never,
      }),
    ).toBeUndefined()
  })

  it('render：输出汇总 + 明细，明细条数受 maxDetailLines 控制', async () => {
    const filePath = await writeReportFixture('render.json', FAILED_CASES)
    const tool = makeTool({ report: { maxDetailLines: 1, includeEvidence: true } })

    const value = await tool.execute({ source: filePath, persistReport: false }, makeExec())
    const content = tool.output.render(undefined as never, value as never)
    const text = content.map(block => (block.type === 'text' ? block.text : '')).join('\n')

    expect(text).toContain('共分析 2 条失败用例')
    expect(text).toContain('## 明细')
    // 只展开 1 条明细
    expect(text.split('   问：').length - 1).toBe(1)
    // includeEvidence 打开时判据会出现
    expect(text).toContain('判据：')

    const withoutEvidence = renderReportText(value as never, 10, false)
    expect(withoutEvidence).not.toContain('判据：')
    expect(withoutEvidence.split('   问：').length - 1).toBe(2)
  })
})

describe('配置 schema', () => {
  it('默认值稳定（改默认值等于改行为，必须有测试兜底）', () => {
    const config = resolveConfig()

    expect(config.strategy).toBe('rule')
    expect(config.maxCases).toBe(200)
    expect(config.rules.confidenceThreshold).toBe(0.55)
    expect(config.llm.provider).toBe('deepseek-official')
    expect(config.llm.fallbackToRules).toBe(true)
    expect(config.report.writeFile).toBe(true)
  })

  it('非法配置在加载阶段就失败', () => {
    expect(() => resolveConfig({ rules: { confidenceThreshold: 2 } })).toThrow(/confidenceThreshold/)
  })
})
