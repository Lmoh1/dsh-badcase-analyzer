/**
 * 规则引擎：用「关键词 + 启发式」给单条失败用例打分并归因。
 *
 * 设计取舍（面试里也讲得清的那部分）：
 * - **只做能说人话的规则**：每条规则必须有明确的 `reason`，因为报告里要给人看判据；
 * - **多维打分而非 if-else 短路**：三个维度各自累积分值，最后取最高分，
 *   避免"一条规则先命中就再也看不到其他信号"的脆弱写法；
 * - **阈值是配置项**：低于 `confidenceThreshold` 一律落到 `unclassified`，
 *   `rule-then-llm` 策略下这些用例会被转交 LLM 复核；
 * - **纯函数**：不读时间、不读环境、不发网络，因此可以直接单测（`tests/rules.spec.ts`）。
 *
 * 已知局限（写进 README，不藏着）：
 * - 字面重合度这类启发式对"同义不同词"的回答会误判（例如问"能不能便宜点"、答"价格是固定的"），
 *   所以这类规则的权重刻意压到阈值以下 —— 宁可标未分类，也不硬凑一个错标签；
 * - 中文分词没有引入依赖，实体识别走正则白名单（单号/金额/时间/联系方式/引号内容）。
 */

import {
  ATTRIBUTION_CATEGORY_SPECS,
  ATTRIBUTION_CATEGORY_LABELS,
  SCORED_CATEGORY_KEYS,
  UNCLASSIFIED,
  defaultSuggestion,
} from './types.ts'
import type {
  AttributionVerdict,
  BadCase,
  ScoredCategory,
} from './types.ts'

// #region 规则引擎的输入输出

/** 规则引擎配置。 */
export interface RuleEngineOptions {
  /** 命中分数低于该阈值时落到 `unclassified`（0~1）。 */
  confidenceThreshold: number
  /**
   * 追加自定义关键词：`{ 归因类别 key 或中文标签: [关键词...] }`。
   * 用于把业务词表（产品名、行业术语、历史上翻过车的表达）喂给引擎，而不改代码。
   */
  extraKeywords?: Record<string, string[]>
}

/** 一条命中的规则。 */
export interface RuleHit {
  /** 规则 id，写进报告判据里，便于追到具体规则。 */
  ruleId: string
  category: ScoredCategory
  /** 该规则的贡献分（0~1），多条命中累加。 */
  weight: number
  /** 人话判据。 */
  reason: string
}

/** 规则引擎的输出。 */
export interface RuleResult {
  verdict: AttributionVerdict
  /** 命中的全部规则（含未采纳类别的），便于调试与后续校准。 */
  hits: RuleHit[]
  /** 三个维度各自的累计分。 */
  scores: Record<ScoredCategory, number>
}

// #endregion

// #region 文本工具

/** 归一化：压缩空白，便于做包含判断。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 返回所有匹配到的子串（自动补全局标志，不改调用方正则的状态）。 */
function findMatches(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  return [...text.matchAll(regex)]
    .map(match => match[0])
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** 文本里是否包含任意一个关键词。 */
function containsAny(text: string, needles: readonly string[]): boolean {
  return needles.some(needle => needle.length > 0 && text.includes(needle))
}

/** 取字符二元组集合（中文没有空格，按 bigram 近似"词"，不引分词依赖）。 */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。？！、；：""''（）《》「」,?!.;:()[\]]+/g, '')
  const result = new Set<string>()
  for (let index = 0; index + 1 < clean.length; index += 1) {
    result.add(clean.slice(index, index + 2))
  }
  return result
}

/**
 * 回答对问题的字面覆盖率（0~1）。
 * 用 `min(集合大小)` 做分母偏向"回答是否覆盖了问题"，而不是惩罚长回答。
 */
function bigramCoverage(question: string, answer: string): number {
  const left = bigrams(question)
  const right = bigrams(answer)
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  for (const gram of left) if (right.has(gram)) common += 1
  return common / Math.min(left.size, right.size)
}

/** 抽取"强实体"：单号、长数字、手机号、座机、400 电话、邮箱、引号里的内容。 */
const ENTITY_PATTERNS: readonly RegExp[] = [
  /\b\d{8,}\b/g, // 订单号 / 流水号 / 长数字
  /\b[A-Z]{2,6}[-_]?\d{4,}\b/g, // SKU-12345 之类的编号
  /\b1[3-9]\d{9}\b/g, // 手机号
  /\b\d{3,4}-\d{7,8}\b/g, // 座机
  /\b400[-\s]?\d{3}[-\s]?\d{4}\b/g, // 400 电话
  /[\w.+-]+@[\w-]+\.[\w.]+/g, // 邮箱
]

const QUOTED_PATTERN = /[「『“"]([^」』”"]{2,20})[」』”"]/g

/** 抽取文本中的关键实体（去重、按出现顺序）。 */
export function extractEntities(text: string): string[] {
  if (text.length === 0) return []
  const found: string[] = []
  for (const pattern of ENTITY_PATTERNS) found.push(...findMatches(text, pattern))
  for (const match of text.matchAll(QUOTED_PATTERN)) {
    const inner = match[1]
    if (typeof inner === 'string' && inner.trim().length >= 2) found.push(inner.trim())
  }
  return [...new Set(found)]
}

/** 抽取阿拉伯数字（保留原始写法，用于"有没有出现同一个数"的比较）。 */
function extractNumbers(text: string): string[] {
  return [...new Set(findMatches(text, /\d+(?:\.\d+)?/g))]
}

/** 抽取带单位的"具体数量"（几元、几天、几个工作日、几折…），这类才是幻觉高发区。 */
function extractQuantities(text: string): string[] {
  return [
    ...new Set(findMatches(text, /\d+(?:\.\d+)?\s*(?:元|块|圆|天|日|小时|分钟|个工作日|工作日|%|％|倍|折|次|件|年|个月|月)/g)
      .map(item => item.replace(/\s+/g, ''))),
  ]
}

/** 回答里是否给出时间信息。 */
const TIME_HINT = /\d+\s*(?:点|时|分|天|日|号|周|小时|工作日|月|年)|明天|后天|今天|昨天|下周|本周|上周|上午|下午|晚上|预计|送达|到达|发出/

/** 回答里是否给出联系方式。 */
const CONTACT_HINT = /(\d{3,4}[-\s]?\d{7,8}|1[3-9]\d{9}|400[-\s]?\d{3}[-\s]?\d{4}|[^\s@]+@[^\s@]+\.[a-z]{2,})/i

// #endregion

// #region 词表

/** 绝对化断言：过度承诺、编造"一贯如此"的政策。 */
const ABSOLUTE_ASSERTIONS = ['一定', '必然', '保证', '一律', '全部', '永久', '无条件', '绝不', '从不', '任何人', '任何情况']

/** 处罚 / 赔偿动作：模型最爱编造的"我们已经处理了对方"。 */
const PUNITIVE_ACTIONS = [
  '扣除当月', '扣除工资', '扣工资', '停职', '开除', '辞退', '罚款', '封号', '永久封禁',
  '列入黑名单', '十倍赔偿', '假一赔十', '全额赔偿', '无条件退款', '已报警',
]

/**
 * 诉求族：问题里出现「问法」，回答里应出现任一「回应词」。
 * 只有"问题问了、回答完全没接"才算意图偏差 —— 这是本引擎判别意图最硬的一条信号。
 */
const INTENT_FAMILIES: readonly { id: string; asks: RegExp; replies: RegExp }[] = [
  { id: 'refund', asks: /退款|退货|换货|退钱|退回|退到/, replies: /退款|退货|换货|退回|退到|原路|银行卡|支付宝|花呗|余额|运费险/ },
  { id: 'invoice', asks: /发票|开票|税号|抬头/, replies: /发票|开票|税号|抬头|电子票/ },
  { id: 'logistics', asks: /物流|快递|到哪|什么时候到|几天到|发货|签收|运单/, replies: /物流|快递|发货|签收|送达|运单|配送到|到达|派送/ },
  { id: 'complaint', asks: /投诉|举报|差评|态度/, replies: /投诉|工单|专员|回访|反馈|处理/ },
  { id: 'pricing', asks: /便宜|优惠|折扣|降价|议价|砍价|满减|优惠券/, replies: /价格|优惠|折扣|满减|券|活动|议价|售价/ },
  { id: 'address', asks: /改地址|收货地址|换地址|送错/, replies: /地址|收货|修改|配送/ },
  { id: 'cancel', asks: /取消订单|撤销|不想要了/, replies: /取消|撤销|拦截|关单/ },
  { id: 'account', asks: /注销|解绑|换绑|改手机号/, replies: /注销|解绑|换绑|手机号|验证/ },
  { id: 'contact', asks: /客服电话|联系方式|热线|邮箱|工作时间/, replies: /电话|热线|客服|邮箱|服务时间|400/ },
]

// #endregion

// #region 归因主流程

/** 规则引擎的置信度上限：启发式再准也不该给出"近乎确定"的数字。 */
const MAX_RULE_CONFIDENCE = 0.9

/** 空的分数表。 */
function emptyScores(): Record<ScoredCategory, number> {
  return {
    logic_hallucination: 0,
    entity_omission: 0,
    intent_misunderstanding: 0,
  }
}

/** 保留三位小数。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 把自定义关键词表里的 key（类别 key 或中文标签）解析成类别。 */
function resolveScoredCategory(raw: string): ScoredCategory | undefined {
  const trimmed = raw.trim()
  for (const spec of ATTRIBUTION_CATEGORY_SPECS) {
    if (spec.key === trimmed || spec.label === trimmed) return spec.key
  }
  return undefined
}

/**
 * 对一条失败用例做规则归因。
 *
 * @param badCase - 归一化后的失败用例（`expected` 可为空，为空时跳过依赖期望答案的规则）。
 * @param options - 置信度阈值与自定义关键词。
 * @returns 归因结论（可能是 `unclassified`）+ 命中的规则 + 三维度分数。
 */
export function attributeWithRules(badCase: BadCase, options: RuleEngineOptions): RuleResult {
  const question = normalizeText(badCase.question)
  const answer = normalizeText(badCase.modelAnswer)
  const expected = normalizeText(badCase.expected ?? '')

  const hits: RuleHit[] = []
  const record = (ruleId: string, category: ScoredCategory, weight: number, reason: string): void => {
    hits.push({ ruleId, category, weight, reason })
  }

  const questionEntities = extractEntities(question)
  const expectedEntities = extractEntities(expected)
  const questionNumbers = extractNumbers(question)
  const answerNumbers = extractNumbers(answer)
  const expectedNumbers = extractNumbers(expected)

  // ── 维度一：逻辑幻觉 ─────────────────────────────────────────
  // 编造法律依据：回答引用《…》或第 N 条，而期望答案里根本没有法条。
  const legalCitations = findMatches(answer, /《[^》]{2,30}》|第[0-9一二三四五六七八九十百千零〇]{1,6}条|第[0-9一二三四五六七八九十百千零〇]{1,6}款/g)
  if (legalCitations.length > 0 && !containsAny(expected, legalCitations)) {
    record(
      'hallucination.legal-citation',
      'logic_hallucination',
      0.55,
      `回答引用了期望答案中没有的法律依据：${legalCitations.slice(0, 2).join('、')}`,
    )
  }

  // 绝对化断言：回答把有条件的政策说成铁律。
  const answerAbsolutes = ABSOLUTE_ASSERTIONS.filter(word => answer.includes(word))
  const expectedAbsolutes = ABSOLUTE_ASSERTIONS.filter(word => expected.includes(word))
  if (answerAbsolutes.length > 0 && expectedAbsolutes.length === 0) {
    record(
      'hallucination.absolute-assertion',
      'logic_hallucination',
      0.45,
      `回答使用绝对化断言（${answerAbsolutes.join('、')}），期望答案中没有对应的绝对表述`,
    )
  }

  // 编造处罚动作：声称已经扣工资/停职/封号。
  const punitive = PUNITIVE_ACTIONS.filter(word => answer.includes(word))
  if (punitive.length > 0 && !containsAny(expected, punitive)) {
    record(
      'hallucination.punitive-action',
      'logic_hallucination',
      0.5,
      `回答声称已执行处罚动作（${punitive.join('、')}），期望答案未提及`,
    )
  }

  // 数字与期望冲突：期望里给了关键数字，回答给了另一套数字。
  if (expectedNumbers.length > 0 && answerNumbers.length > 0) {
    const required = expectedNumbers.filter(item => !questionNumbers.includes(item))
    if (required.length > 0 && required.every(item => !answerNumbers.includes(item))) {
      record(
        'hallucination.number-conflict',
        'logic_hallucination',
        0.55,
        `回答中的数字（${answerNumbers.slice(0, 3).join('、')}）与期望答案要求的关键数字`
          + `（${required.slice(0, 3).join('、')}）完全不一致`,
      )
    }
  }

  // 凭空出现的具体数量：问题和期望都没给，回答却给了带单位的数字。
  const answerQuantities = extractQuantities(answer)
  const fabricatedQuantities = answerQuantities.filter(
    item => !extractQuantities(expected).includes(item) && !extractQuantities(question).includes(item),
  )
  if (fabricatedQuantities.length > 0) {
    record(
      'hallucination.extra-quantity',
      'logic_hallucination',
      0.3,
      `回答出现来源不明的具体数量：${fabricatedQuantities.slice(0, 3).join('、')}（问题与期望都未提供）`,
    )
  }

  // ── 维度二：实体抽取遗漏 ─────────────────────────────────────
  const missingQuestionSlots = questionEntities.filter(entity => !answer.includes(entity))
  if (missingQuestionSlots.length > 0) {
    record(
      'entity.missing-question-slot',
      'entity_omission',
      0.6,
      `问题里的关键实体在回答里消失了：${missingQuestionSlots.slice(0, 3).join('、')}`,
    )
  }

  const missingExpectedSlots = expectedEntities.filter(entity => !answer.includes(entity))
  if (missingExpectedSlots.length > 0) {
    record(
      'entity.missing-expected-slot',
      'entity_omission',
      0.5,
      `期望答案里的关键实体在回答里缺失：${missingExpectedSlots.slice(0, 3).join('、')}`,
    )
  }

  if (/什么时候|何时|多久|几天|几号|哪天/.test(question) && !TIME_HINT.test(answer)) {
    record('entity.missing-time', 'entity_omission', 0.45, '问题在问时间，回答里没有任何时间信息')
  }

  if (/(多少钱|价格|费用|运费|多少元|贵不贵)/.test(question) && !/[\d一二三四五六七八九十百千万]/.test(answer)) {
    record('entity.missing-quantity', 'entity_omission', 0.4, '问题在问金额，回答里没有任何数字')
  }

  if (/(客服电话|联系方式|电话|邮箱|怎么联系)/.test(question) && !CONTACT_HINT.test(answer)) {
    record('entity.missing-contact', 'entity_omission', 0.5, '问题在要联系方式，回答里没有可用的联系方式')
  }

  if (answer.length <= 12 && (questionEntities.length > 0 || question.length >= 12)) {
    record(
      'entity.answer-too-short',
      'entity_omission',
      0.35,
      `回答过短（${answer.length} 字），无法覆盖问题的关键信息`,
    )
  }

  // ── 维度三：意图识别偏差 ─────────────────────────────────────
  // 目标变更被忽略：「改成 / 换成 X」但回答里没有 X。
  const targetChange = /(?:改成|换成|改为|变成|转到|退到|换到)([^\s，。？！,?!；;]{2,12})/.exec(question)
  const targetValue = targetChange?.[1]?.trim()
  if (targetValue !== undefined && targetValue.length >= 2 && !answer.includes(targetValue)) {
    record(
      'intent.ignored-target',
      'intent_misunderstanding',
      0.55,
      `问题要求「改成/换成 ${targetValue}」，回答没有接住这个目标`,
    )
  }

  // 诉求族完全没被回应：问题问了某个诉求，回答里连一个回应词都没有。
  for (const family of INTENT_FAMILIES) {
    if (family.asks.test(question) && !family.replies.test(answer)) {
      record(
        `intent.unaddressed-${family.id}`,
        'intent_misunderstanding',
        0.5,
        `问题属于「${family.id}」类诉求，回答里没有任何对应的回应`,
      )
    }
  }

  // 主题漂移：字面重合度极低（同义不同词会误判，故权重压在阈值附近以下）。
  const coverage = bigramCoverage(question, answer)
  if (question.length >= 8 && answer.length >= 10 && coverage < 0.08) {
    record(
      'intent.topic-drift',
      'intent_misunderstanding',
      0.45,
      `回答与问题的字面重合度极低（bigram 覆盖率 ${round3(coverage)}），疑似答非所问`,
    )
  }

  // 否定翻转：问题是否定/禁止，回答却给了硬性肯定。
  if (/(不要|别|不能|不允许|禁止|不许)/.test(question) && /(可以的|没问题|当然|一定可以|支持)/.test(answer) && !/(不能|不可以|不支持)/.test(answer)) {
    record(
      'intent.negation-flip',
      'intent_misunderstanding',
      0.5,
      '问题包含否定/禁止表达，回答却给了肯定承诺',
    )
  }

  // ── 自定义关键词（业务词表）─────────────────────────────────
  const extraKeywords = options.extraKeywords ?? {}
  for (const [rawCategory, keywords] of Object.entries(extraKeywords)) {
    const category = resolveScoredCategory(rawCategory)
    if (category === undefined || !Array.isArray(keywords)) continue
    const matched = keywords.filter(word => typeof word === 'string' && word.length > 0
      && (question.includes(word) || answer.includes(word)))
    if (matched.length > 0) {
      record(
        `custom.${category}`,
        category,
        0.4,
        `命中自定义关键词（${ATTRIBUTION_CATEGORY_LABELS[category]}）：${matched.slice(0, 3).join('、')}`,
      )
    }
  }

  // ── 汇总取最高分 ────────────────────────────────────────────
  const scores = emptyScores()
  for (const hit of hits) scores[hit.category] += hit.weight

  let bestCategory: ScoredCategory = 'logic_hallucination'
  let bestScore = 0
  for (const category of SCORED_CATEGORY_KEYS) {
    if (scores[category] > bestScore) {
      bestScore = scores[category]
      bestCategory = category
    }
  }

  const threshold = options.confidenceThreshold
  const categoryHits = hits.filter(hit => hit.category === bestCategory)
  const evidence = categoryHits.length > 0
    ? categoryHits.slice(0, 5).map(hit => `[${hit.ruleId}] ${hit.reason}`)
    : ['规则引擎未命中任何信号（低于置信度阈值或缺少可判定线索）']

  // 分数不够 → 未分类。宁可不给结论，也不要给错标签污染统计。
  if (bestScore <= 0 || bestScore < threshold) {
    return {
      hits,
      scores,
      verdict: {
        category: UNCLASSIFIED,
        confidence: round3(Math.min(MAX_RULE_CONFIDENCE, bestScore)),
        method: 'rule',
        evidence: [
          ...evidence,
          `最高分 ${round3(bestScore)} 低于阈值 ${threshold}，故不归入三大类`,
        ],
        suggestion: defaultSuggestion(UNCLASSIFIED),
      },
    }
  }

  return {
    hits,
    scores,
    verdict: {
      category: bestCategory,
      confidence: round3(Math.min(MAX_RULE_CONFIDENCE, bestScore)),
      method: 'rule',
      evidence,
      suggestion: `命中信号「${categoryHits[0]?.ruleId ?? bestCategory}」：${categoryHits[0]?.reason ?? ''}。`
        + defaultSuggestion(bestCategory),
    },
  }
}

// #endregion
