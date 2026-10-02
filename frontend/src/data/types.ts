/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

// 指标统计规则：按状态计数，或对某个数值字段求和。概览和列表页共用同一份规则，不再各算各的。
export type MetricRule =
  | { kind: 'status'; label: string; status: string }
  | { kind: 'sum'; label: string; field: string }

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 该模块指标的显式口径；不写时按「指标名包含状态名」兜底推断。
  metricRules?: MetricRule[]
  // 概览模块表展示的关键指标；不写时取 metrics 的第一项。
  keyMetric?: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: {
    name: string
    created: number
    pending: number
    abnormal: number
    metricLabel: string
    metricValue: number
  }[]
}
