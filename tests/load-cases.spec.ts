import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadBadCases } from '../src/tool/badcase-analyze.ts'

/**
 * 输入归一化（`loadBadCases`）。
 *
 * 文件一律写到系统临时目录：既保证测试之间互不影响，也避免在仓库里留垃圾。
 */

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-badcase-cases-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** 写一个 JSON 夹具文件，返回绝对路径。 */
async function writeJson(name: string, value: unknown): Promise<string> {
  const filePath = join(tempDir, name)
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
  return filePath
}

/** 原样写入文本（用于制造非法 JSON）。 */
async function writeRaw(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name)
  await writeFile(filePath, content, 'utf8')
  return filePath
}

const BASE = { cwd: process.cwd(), maxCases: 100 }

describe('来源解析：文件 / 内联数组', () => {
  it('读取 DSH 风格的评测报告（自动探测 results 字段）', async () => {
    const filePath = await writeJson('report.json', {
      runId: 'eval-1',
      results: [
        { caseId: 'a', question: 'q1', modelAnswer: 'a1', pass: false },
        { caseId: 'b', question: 'q2', modelAnswer: 'a2', pass: true },
        { caseId: 'c', question: 'q3', modelAnswer: 'a3', pass: false },
      ],
    })

    const loaded = await loadBadCases(filePath, BASE)

    expect(loaded.sourceKind).toBe('file')
    expect(loaded.sourceLabel).toBe(filePath)
    expect(loaded.total).toBe(3)
    expect(loaded.cases.map(item => item.caseId)).toEqual(['a', 'c'])
    expect(loaded.skipped).toHaveLength(1)
    expect(loaded.skipped[0]?.reason).toContain('已通过')
  })

  it('相对路径按传入的 cwd 解析（不是 process.cwd）', async () => {
    await writeJson('relative.json', [
      { caseId: 'rel', question: 'q', modelAnswer: 'a' },
    ])

    const loaded = await loadBadCases('relative.json', { ...BASE, cwd: tempDir })

    expect(loaded.sourceLabel).toBe(join(tempDir, 'relative.json'))
    expect(loaded.cases).toHaveLength(1)
  })

  it('内联数组：sourceKind=inline，label 带条数', async () => {
    const loaded = await loadBadCases(
      [
        { caseId: 'x1', question: 'q1', modelAnswer: 'a1' },
        { caseId: 'x2', question: 'q2', modelAnswer: 'a2' },
        { caseId: 'x3', question: 'q3', modelAnswer: 'a3' },
      ],
      BASE,
    )

    expect(loaded.sourceKind).toBe('inline')
    expect(loaded.sourceLabel).toBe('inline:3')
    expect(loaded.total).toBe(3)
    expect(loaded.cases).toHaveLength(3)
  })

  it('其它常见数组字段名也能识别（cases / items / data / samples / records）', async () => {
    for (const key of ['cases', 'items', 'data', 'samples', 'records']) {
      const filePath = await writeJson(`${key}.json`, {
        [key]: [{ caseId: key, question: 'q', modelAnswer: 'a' }],
      })
      const loaded = await loadBadCases(filePath, BASE)
      expect(loaded.cases.map(item => item.caseId)).toEqual([key])
    }
  })
})

describe('字段归一化：别名与类型容错', () => {
  it('把不同框架的字段名收敛到规范字段', async () => {
    const loaded = await loadBadCases([
      {
        id: 'alias-1',
        query: '怎么退款',
        response: '在订单页点退款',
        groundTruth: '在订单详情页申请退款',
        categories: ['refund', 'policy'],
      },
    ], BASE)

    expect(loaded.cases[0]).toEqual({
      caseId: 'alias-1',
      question: '怎么退款',
      modelAnswer: '在订单页点退款',
      expected: '在订单详情页申请退款',
      tags: ['refund', 'policy'],
    })
  })

  it('pass / passed / status 的多种写法都能判定通过', async () => {
    const loaded = await loadBadCases([
      { caseId: 'p1', question: 'q', modelAnswer: 'a', pass: true },
      { caseId: 'p2', question: 'q', modelAnswer: 'a', passed: 'passed' },
      { caseId: 'p3', question: 'q', modelAnswer: 'a', status: 'ok' },
      { caseId: 'f1', question: 'q', modelAnswer: 'a', status: 'fail' },
    ], BASE)

    expect(loaded.cases.map(item => item.caseId)).toEqual(['f1'])
    expect(loaded.skipped).toHaveLength(3)
  })

  it('缺省 pass 时按失败处理（只分析 Bad Case）', async () => {
    const loaded = await loadBadCases([{ caseId: 'no-flag', question: 'q', modelAnswer: 'a' }], BASE)

    expect(loaded.cases).toHaveLength(1)
    expect(loaded.skipped).toHaveLength(0)
  })

  it('tags 支持数组与分隔字符串两种写法，并自动去空', async () => {
    const loaded = await loadBadCases([
      { caseId: 't1', question: 'q', modelAnswer: 'a', tags: ['refund', '', 'policy'] },
      { caseId: 't2', question: 'q', modelAnswer: 'a', tags: 'refund,policy| multi-turn ' },
    ], BASE)

    expect(loaded.cases[0]?.tags).toEqual(['refund', 'policy'])
    expect(loaded.cases[1]?.tags).toEqual(['refund', 'policy', 'multi-turn'])
  })

  it('空白字符串字段视为缺失', async () => {
    const loaded = await loadBadCases([{ caseId: 'blank', question: '   ', modelAnswer: 'a' }], BASE)

    expect(loaded.cases).toHaveLength(0)
    expect(loaded.skipped[0]?.reason).toContain('缺少 question 或 modelAnswer')
  })
})

describe('跳过与截断：报告里要能说清"为什么少了几条"', () => {
  it('缺 question / modelAnswer 的条目被跳过并说明原因', async () => {
    const loaded = await loadBadCases([{ caseId: 'no-answer', question: '只有问题' }], BASE)

    expect(loaded.cases).toHaveLength(0)
    expect(loaded.skipped).toEqual([
      { caseId: 'no-answer', reason: '缺少 question 或 modelAnswer 字段，无法归因' },
    ])
  })

  it('非对象条目被跳过，且用 case-<序号> 标记', async () => {
    const loaded = await loadBadCases(
      [42, 'a string', null, { caseId: 'ok', question: 'q', modelAnswer: 'a' }],
      BASE,
    )

    expect(loaded.cases.map(item => item.caseId)).toEqual(['ok'])
    expect(loaded.skipped.map(item => item.caseId)).toEqual(['case-1', 'case-2', 'case-3'])
    expect(loaded.skipped[0]?.reason).toContain('不是对象')
  })

  it('缺 caseId 时用 case-<序号> 兜底', async () => {
    const loaded = await loadBadCases([
      { question: 'q1', modelAnswer: 'a1' },
      { question: 'q2', modelAnswer: 'a2' },
    ], BASE)

    expect(loaded.cases.map(item => item.caseId)).toEqual(['case-1', 'case-2'])
  })

  it('maxCases 截断：超出的条目计入 skipped', async () => {
    const loaded = await loadBadCases([
      { caseId: 'm1', question: 'q', modelAnswer: 'a' },
      { caseId: 'm2', question: 'q', modelAnswer: 'a' },
      { caseId: 'm3', question: 'q', modelAnswer: 'a' },
    ], { ...BASE, maxCases: 2 })

    expect(loaded.cases).toHaveLength(2)
    expect(loaded.skipped).toEqual([
      { caseId: 'm3', reason: '超过 maxCases=2 上限，本次未分析' },
    ])
  })

  it('caseIds 过滤：只保留指定用例，其余计入 skipped', async () => {
    const loaded = await loadBadCases([
      { caseId: 'a', question: 'q', modelAnswer: 'a' },
      { caseId: 'b', question: 'q', modelAnswer: 'a' },
      { caseId: 'c', question: 'q', modelAnswer: 'a' },
    ], { ...BASE, caseIds: ['b'] })

    expect(loaded.cases.map(item => item.caseId)).toEqual(['b'])
    expect(loaded.skipped.map(item => item.caseId)).toEqual(['a', 'c'])
    expect(loaded.skipped[0]?.reason).toContain('caseIds')
  })
})

describe('错误处理：失败要响亮，不要静默给空报告', () => {
  it('非法 JSON 抛错并带上文件路径', async () => {
    const filePath = await writeRaw('broken.json', '{ this is not json')

    await expect(loadBadCases(filePath, BASE)).rejects.toThrow(/解析评测结果 JSON 失败/)
  })

  it('找不到用例数组时抛错并说明期望的形状', async () => {
    const filePath = await writeJson('no-array.json', { runId: 'x', somethingElse: 1 })

    await expect(loadBadCases(filePath, BASE)).rejects.toThrow(/找不到用例数组/)
  })

  it('文件不存在时抛错', async () => {
    await expect(loadBadCases(join(tempDir, 'missing.json'), BASE)).rejects.toThrow(/ENOENT/)
  })

  it('已中止的信号会让读取立刻失败', async () => {
    await expect(
      loadBadCases([{ caseId: 'x', question: 'q', modelAnswer: 'a' }], {
        ...BASE,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
  })
})
