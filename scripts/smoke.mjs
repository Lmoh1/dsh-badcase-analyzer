/**
 * 自检脚本：**不需要 DSH 实例、也不需要真实 API Key**，直接跑通整条链路。
 *
 * 覆盖：
 *   1. `Config` schema 默认值填充 + 非法配置拒绝；
 *   2. `defineTool` 构造（校验参数/输出两套 schema DSL）+ 入参与返回值的 schema 校验；
 *   3. `rule` 策略：规则引擎对样例 6 条失败用例的真实归因结果（逐条断言）；
 *   4. `llm` 策略：用**假 LLM 流**（注入一个只有 stream() 的对象）验证 Prompt 发送与 JSON 解析；
 *   5. LLM 失败（抛错）时的降级：`fallbackToRules: true` → 回退规则结果；
 *   6. `rule-then-llm` 策略：只有规则没把握的用例才会走到 LLM（断言调用次数）；
 *   7. 解析健壮性：非法 JSON 触发重试、类别非法抛错、max-tokens 截断抛错；
 *   8. `render` / `presentationMeta` / `presentCall` / `presentResult`（必须是纯函数，不能抛）；
 *   9. 内联数组输入、caseIds 过滤、persistReport=false 分支。
 *
 * 用法：
 *   pnpm build && node scripts/smoke.mjs
 *
 * import 走构建产物 `lib/`，因此顺便验证 tsc 的产物路径与导出。
 */

import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import {
  Config,
  LlmAttributionError,
  attributeCases,
  attributeWithLlm,
  badcaseAnalyzeTool,
  parseAttributionReply,
} from '../lib/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const samplePath = resolve(repoRoot, 'examples/badcases.sample.json')

let failures = 0
/** 轻量断言：失败不中断，最后统一汇报（冒烟脚本要一次看到所有问题）。 */
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    console.log(`  ✅ ${label}`)
  } catch {
    failures += 1
    console.log(`  ❌ ${label}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}`)
  }
}

function print(message) {
  console.log(message)
}

// ── 假 LLM：只要有 stream(options) 就是一个合法的 LlmStreamer ────────────
/**
 * @param {string | Error | ((call: number, options: any) => string | Error)} script
 *   固定回复 / 直接抛错 / 按调用序号返回。
 * @param {any[]} log 调用记录（provider、model、temperature、system、user prompt）。
 */
function createFakeLlm(script, log = []) {
  let calls = 0
  return {
    log,
    get callCount() {
      return calls
    },
    stream(options) {
      calls += 1
      const firstContent = options.messages?.[0]?.content?.[0]?.text ?? ''
      log.push({
        call: calls,
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        hasSystem: typeof options.system === 'string',
        prompt: firstContent,
      })
      const step = typeof script === 'function' ? script(calls, options) : script
      return (async function* fakeStream() {
        if (step instanceof Error) throw step
        yield { type: 'block-start', index: 0, blockType: 'text' }
        // 分片吐出，模拟真实流式（顺便验证增量拼接）
        for (let index = 0; index < step.length; index += 24) {
          yield { type: 'text-delta', index: 0, text: step.slice(index, index + 24) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 假 LLM 的一档"截断"回复：finish 原因是 max-tokens。 */
function createTruncatingLlm() {
  return {
    stream() {
      return (async function* truncated() {
        yield { type: 'text-delta', index: 0, text: '{"category":"logic_' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })()
    },
  }
}

const LLM_JSON = '{"category":"entity_omission","confidence":0.8,'
  + '"evidence":["回答没有覆盖期望答案要求的抬头信息"],"suggestion":"补齐发票抬头与企业信息"}'

// ── 1. 配置 ─────────────────────────────────────────────────────
print('\n[1] 配置 schema')
const config = Config({})
print('  默认配置：' + JSON.stringify(config))
check('策略默认 rule', config.strategy, 'rule')
check('LLM 回退默认开启', config.llm.fallbackToRules, true)
try {
  Config({ rules: { confidenceThreshold: 2 } })
  failures += 1
  console.log('  ❌ 非法配置（阈值 2）本应被拒绝')
} catch (error) {
  console.log(`  ✅ 非法配置被拒绝：${error.message.split('\n')[0]}`)
}

// ── 2. 构造工具 + schema ────────────────────────────────────────
print('\n[2] 工具契约')
const tool = badcaseAnalyzeTool({ ctx: {}, config })
const exec = { signal: new AbortController().signal }
const args = { source: samplePath }
check('入参满足 parameters schema', validateJsonSchemaValue(tool.parameters, args, ''), [])
print(`  parameters 顶层字段：${Object.keys(tool.parameters.properties).join(', ')}`)

// ── 3. rule 策略：规则引擎真实归因 ───────────────────────────────
print('\n[3] rule 策略（纯规则引擎，零成本）')
const ruleValue = await tool.execute(args, exec)
check('返回值满足 output.schema', validateJsonSchemaValue(tool.output.schema, ruleValue, ''), [])

const categoryOf = report => Object.fromEntries(report.cases.map(item => [item.caseId, item.category]))
const ruleMap = categoryOf(ruleValue)
print('  归因结果：' + JSON.stringify(ruleMap, null, 2).replace(/\n/g, '\n  '))
print(`  summary：${JSON.stringify(ruleValue.summary)}`)

check('cs-001 忽略「改成退到花呗」→ 意图识别偏差', ruleMap['cs-001'], 'intent_misunderstanding')
check('cs-003 漏掉订单号 → 实体抽取遗漏', ruleMap['cs-003'], 'entity_omission')
check('cs-004 编造处罚动作 → 逻辑幻觉', ruleMap['cs-004'], 'logic_hallucination')
check('cs-005 编造法条 → 逻辑幻觉', ruleMap['cs-005'], 'logic_hallucination')
check('规则没把握的落到未分类（宁缺勿滥）', ruleValue.summary.unclassified, 2)
check('三类统计合计 = 已分析数', ruleValue.summary.byCategory.reduce((sum, item) => sum + item.count, 0) + ruleValue.summary.unclassified, ruleValue.summary.analyzed)
check('通过用例被跳过', ruleValue.summary.skipped, 1)

const cs001 = ruleValue.cases.find(item => item.caseId === 'cs-001')
print(`  cs-001 判据：${cs001.evidence.join(' | ')}`)
print(`  cs-001 建议：${cs001.suggestion.slice(0, 80)}…`)

// ── 4. llm 策略：假 LLM 流 ──────────────────────────────────────
print('\n[4] llm 策略（用假流替代真实模型，无需 API Key）')
const llmLog = []
const fakeLlm = createFakeLlm(LLM_JSON, llmLog)
const llmTool = badcaseAnalyzeTool({ ctx: { llm: fakeLlm }, config })
const llmValue = await llmTool.execute({ ...args, strategy: 'llm', persistReport: false }, exec)

check('每条都走 LLM（method=llm）', llmValue.cases.every(item => item.method === 'llm'), true)
check('LLM 调用次数 = 分析条数', llmLog.length, llmValue.cases.length)
check('传了 provider', llmLog[0]?.provider, config.llm.provider)
check('传了 system 提示词', llmLog[0]?.hasSystem, true)
check('user 提示词包含用例三元组', /【用户问题】[\s\S]*【模型回答】[\s\S]*【期望回答】/.test(llmLog[0]?.prompt ?? ''), true)
check('按模型给的类别归类', categoryOf(llmValue)['cs-001'], 'entity_omission')
print(`  示例 prompt 片段：${(llmLog[0]?.prompt ?? '').split('\n').slice(0, 2).join(' / ')}`)

// ── 5. LLM 失败时的降级 ─────────────────────────────────────────
print('\n[5] LLM 失败 → 回退规则结果（fallbackToRules 默认开启）')
const brokenTool = badcaseAnalyzeTool({ ctx: { llm: createFakeLlm(new Error('模拟网络错误')) }, config })
const degraded = await brokenTool.execute({ ...args, strategy: 'llm', persistReport: false }, exec)
check('全部标记为 fallback', degraded.cases.every(item => item.method === 'fallback'), true)
check('降级后仍保留规则结论（cs-005 → 逻辑幻觉）', categoryOf(degraded)['cs-005'], 'logic_hallucination')
print(`  降级判据示例：${degraded.cases.find(item => item.caseId === 'cs-005').evidence.at(-1)}`)

print('\n[5b] 关闭回退 → 一律未分类')
const strictTool = badcaseAnalyzeTool({
  ctx: { llm: createFakeLlm(new Error('模拟网络错误')) },
  config: Config({ llm: { fallbackToRules: false } }),
})
const strictValue = await strictTool.execute({ ...args, strategy: 'llm', persistReport: false }, exec)
check('全部未分类', strictValue.cases.every(item => item.category === 'unclassified'), true)

// ── 6. rule-then-llm：只有没把握的才花钱 ────────────────────────
print('\n[6] rule-then-llm 策略（省钱：只把没把握的交给 LLM）')
const mixedLog = []
const mixedTool = badcaseAnalyzeTool({ ctx: { llm: createFakeLlm(LLM_JSON, mixedLog) }, config })
const mixedValue = await mixedTool.execute({ ...args, strategy: 'rule-then-llm', persistReport: false }, exec)
const byMethod = mixedValue.cases.reduce((acc, item) => {
  acc[item.method] = (acc[item.method] ?? 0) + 1
  return acc
}, {})
print(`  method 分布：${JSON.stringify(byMethod)}；LLM 调用 ${mixedLog.length} 次`)
check('LLM 只被调用 2 次（两条规则未分类）', mixedLog.length, 2)
check('规则有把握的仍是方法 rule', byMethod.rule, 4)
check('未分类的由 LLM 接手', byMethod.llm, 2)

// ── 7. 解析健壮性：重试 / 非法类别 / 截断 ────────────────────────
print('\n[7] LLM 输出解析的健壮性')
const retryLog = []
const retryLlm = createFakeLlm(call => (call === 1 ? '我不太确定，可能是意图问题吧' : LLM_JSON), retryLog)
const retried = await attributeWithLlm(
  { caseId: 'cs-x', question: '能开发票吗', modelAnswer: '可以的' },
  { llm: retryLlm, settings: { provider: 'p', model: 'm', temperature: 0, maxOutputTokens: 256, timeoutMs: 5000 } },
)
check('首次输出非 JSON → 自动重试成功', retried.category, 'entity_omission')
check('正好重试了一次（共 2 次调用）', retryLog.length, 2)
check('第二次追加了强约束提示', retryLog[1].prompt.includes('只输出一个 JSON 对象'), true)

try {
  parseAttributionReply('{"category":"完全不存在的类别","confidence":0.5}')
  failures += 1
  console.log('  ❌ 非法类别本应抛错')
} catch (error) {
  console.log(`  ✅ 非法类别被拒绝：${error instanceof LlmAttributionError ? error.code : 'unknown'} / ${error.message}`)
}

try {
  await attributeWithLlm(
    { caseId: 'cs-y', question: 'q', modelAnswer: 'a' },
    { llm: createTruncatingLlm(), settings: { provider: 'p', model: 'm', temperature: 0, maxOutputTokens: 8, timeoutMs: 5000 } },
  )
  failures += 1
  console.log('  ❌ 输出截断本应抛错')
} catch (error) {
  check('输出被 max-tokens 截断 → 明确报错', error.code, 'LLM_TRUNCATED')
}

// ── 8. 渲染与卡片投影（纯函数）──────────────────────────────────
print('\n[8] 模型可见文本与 UI 卡片投影')
const content = tool.output.render(args, ruleValue)
const text = content.map(block => (block.type === 'text' ? block.text : `<${block.type}>`)).join('\n')
print('\n' + text.split('\n').slice(0, 8).join('\n') + '\n  …\n')

const meta = tool.output.presentationMeta?.(args, ruleValue)
check('presentationMeta 数字与报告一致', meta.total, ruleValue.summary.analyzed)
check('presentationMeta 带三类分布', meta.byCategory.length, 3)
print(`  presentationMeta：${JSON.stringify(meta)}`)
print(`  presentCall：${JSON.stringify(tool.presentCall?.(args))}`)
print(`  presentResult：${JSON.stringify(tool.presentResult?.(args, { content, isError: false, meta }))}`)

// ── 9. 内联数组 + caseIds 过滤 + 不落盘 ─────────────────────────
print('\n[9] 内联输入 / caseIds 过滤 / 不落盘')
const sample = JSON.parse(await readFile(samplePath, 'utf8'))
const inlineReport = await tool.execute(
  { source: sample.results, caseIds: ['cs-003', 'cs-007'], persistReport: false, strategy: 'rule' },
  exec,
)
check('caseIds 过滤后只剩 1 条失败用例', inlineReport.summary.total, 1)
check('被过滤/通过的都计入 skipped', inlineReport.summary.skipped, 6)
check('persistReport=false 时没有 reportPath', inlineReport.reportPath, undefined)

// ── 收尾 ────────────────────────────────────────────────────────
if (typeof ruleValue.reportPath === 'string') {
  await rm(ruleValue.reportPath, { force: true })
  print(`\n清理生成的报告：${ruleValue.reportPath}`)
}

if (failures > 0) {
  console.log(`\n❌ smoke 失败：${failures} 项断言不通过`)
  process.exitCode = 1
} else {
  console.log('\n✅ smoke 全部通过')
}
