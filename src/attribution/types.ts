/**
 * 归因域的共享数据模型与类别定义。
 *
 * 为什么单独一个文件：`rules.ts` / `llm.ts` / `index.ts` 与工具层都需要这些类型，
 * 但归因层不能反向依赖工具层（会形成 `tool → attribution → tool` 循环）。
 * 所以模型下沉到这里，工具层与归因层都只向下依赖它。
 */

/** 未分类兜底桶：规则未命中且 LLM 不可用/失败时落在这里，不进三大类统计。 */
export const UNCLASSIFIED = 'unclassified'

/**
 * 归因策略（三选一）。
 * - `rule`：只用关键词规则引擎，零依赖、可复现、快；
 * - `llm`：只用大模型归因，召回高、成本高；
 * - `rule-then-llm`：先跑规则，置信度不足的用例再交给 LLM（推荐）。
 *
 * 放在归因域而不是配置文件里：策略是归因层的概念，配置只是把它暴露出去。
 */
export type AttributionStrategy = 'rule' | 'llm' | 'rule-then-llm'

/** 策略枚举，供 Schemastery `union` 与工具参数 `enum` 复用。 */
export const ATTRIBUTION_STRATEGIES = ['rule', 'llm', 'rule-then-llm'] as const

/**
 * 固定三维度归因分类。
 *
 * 维度刻意不做成可配置项：只有维度固定，不同批次/不同人的报告才能横向对比。
 * - `hint` 给 LLM 当判定定义，也是规则引擎注释的依据；
 * - `plays` 是这一类问题的改进套路，用于生成 `suggestion`（人不写、模型不编）。
 */
export const ATTRIBUTION_CATEGORY_SPECS = [
  {
    key: 'intent_misunderstanding',
    label: '意图识别偏差',
    hint: '模型误解了用户意图：答非所问、多轮上下文丢失、把 A 诉求当成 B 诉求、'
      + '忽略「改成 / 换成 / 除了…还要…」这类目标变更。回答方向本身就错了。',
    plays: [
      '把这类意图做成评测样本回灌，并在意图标签集里补齐同义表达',
      '提示词里要求"先复述用户诉求再作答"，多轮场景显式带上历史诉求',
      '意图置信度低时用澄清反问（ask_user）代替直接给结论',
    ],
  },
  {
    key: 'entity_omission',
    label: '实体抽取遗漏',
    hint: '回答方向大致对，但漏掉了问题里的关键实体（订单号、时间、金额、商品名、'
      + '联系方式、型号等），导致答案空泛、不可执行、需要用户再问一遍。',
    plays: [
      '回答前先做槽位抽取（把关键实体列成清单），逐项确认已回填',
      '对订单号/单号/手机号这类唯一标识，走工具查询而不是让模型复述',
      '加一条后处理校验：问题里的数字/单号/联系方式必须在回答里出现',
    ],
  },
  {
    key: 'logic_hallucination',
    label: '逻辑幻觉',
    hint: '编造了并不存在的事实：法条编号、政策条款、物流状态、处罚动作、赔偿承诺、'
      + '优惠活动，或给出与期望答案冲突的具体数字。这类回答"看起来很像真的"。',
    plays: [
      '政策/法条/售后规则类问题强制走检索（RAG），并在回答里给出出处',
      '系统提示词加约束：不确定就说明不确定，禁止编造条款编号与处罚结果',
      '输出前做一次事实一致性校验：回答里的事实点必须能在检索结果里找到依据',
    ],
  },
] as const

/** 归因类别的 key 联合类型（含未分类兜底桶）。 */
export type AttributionCategoryKey =
  | (typeof ATTRIBUTION_CATEGORY_SPECS)[number]['key']
  | typeof UNCLASSIFIED

/** 三大类（不含兜底桶）的 key，打分/统计用。 */
export type ScoredCategory = (typeof ATTRIBUTION_CATEGORY_SPECS)[number]['key']

/** 全部类别 key，供 schema `enum` 与统计遍历使用。 */
export const ATTRIBUTION_CATEGORY_KEYS = [
  'intent_misunderstanding',
  'entity_omission',
  'logic_hallucination',
  UNCLASSIFIED,
] as const satisfies readonly AttributionCategoryKey[]

/** 三大类 key，固定顺序（严重度：幻觉 > 实体 > 意图），用于平票与统计排序。 */
export const SCORED_CATEGORY_KEYS = [
  'logic_hallucination',
  'entity_omission',
  'intent_misunderstanding',
] as const satisfies readonly ScoredCategory[]

/** key → 中文标签。 */
export const ATTRIBUTION_CATEGORY_LABELS: Record<AttributionCategoryKey, string> = {
  intent_misunderstanding: '意图识别偏差',
  entity_omission: '实体抽取遗漏',
  logic_hallucination: '逻辑幻觉',
  unclassified: '未分类（待人工复核）',
}

/** 归因来源：规则引擎 / 大模型 / 兜底。 */
export type AttributionMethod = 'rule' | 'llm' | 'fallback'

/** 归一化后的一条失败用例。 */
export interface BadCase {
  caseId: string
  question: string
  modelAnswer: string
  /** 期望答案，可选：有它规则引擎才能做「该有的实体有没有」的判定。 */
  expected?: string
  /** 评测框架自带的标签，透传到报告，便于二次切片分析。 */
  tags?: string[]
}

/** 单条归因结论。 */
export interface AttributionVerdict {
  category: AttributionCategoryKey
  confidence: number
  /** 判据：为什么归到这一类（人可以据此复查，模型据此改进）。 */
  evidence: string[]
  /** 改进建议：落到数据/提示词/检索/后处理上的具体动作。 */
  suggestion: string
  method: AttributionMethod
}

/** 报告里的一条 Case：用例字段 + 归因结论（拍平，方便下游直接消费）。 */
export interface AnalyzedCase extends BadCase, AttributionVerdict {
  categoryLabel: string
}

/** 判断某个值是否是合法类别 key（LLM 输出校验用）。 */
export function isAttributionCategoryKey(value: unknown): value is AttributionCategoryKey {
  return typeof value === 'string'
    && (ATTRIBUTION_CATEGORY_KEYS as readonly string[]).includes(value)
}

/**
 * 把「key 或中文标签」解析成类别 key。
 * LLM 有时会把 `logic_hallucination` 写成 `逻辑幻觉`，这里两种都收，
 * 避免为了一个字段名的差异就重试一次调用。
 */
export function resolveCategoryKey(value: unknown): AttributionCategoryKey | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (isAttributionCategoryKey(trimmed)) return trimmed
  for (const spec of ATTRIBUTION_CATEGORY_SPECS) {
    if (spec.label === trimmed) return spec.key
  }
  return undefined
}

/** 取某个类别的改进套路（给 `suggestion` 兜底用）。 */
export function categoryPlays(key: AttributionCategoryKey): readonly string[] {
  const spec = ATTRIBUTION_CATEGORY_SPECS.find(item => item.key === key)
  return spec?.plays ?? []
}

/** 用类别套路拼一句兜底建议（规则/LLM 都没给建议时用）。 */
export function defaultSuggestion(key: AttributionCategoryKey): string {
  if (key === UNCLASSIFIED) {
    return '规则与 LLM 都未给出高置信度结论：建议人工抽检，并把这条用例补进标注集，'
      + '用于校准规则词表或补充 LLM few-shot 示例。'
  }
  return `建议：${categoryPlays(key).join('；')}`
}
