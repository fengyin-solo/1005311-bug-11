import type { EntryRow, ModuleMeta } from './types'

// 概览、列表图例、各模块指标卡片共用这一份口径：都从同一批探方/条目记录直接派生，
// 谁也不再各写一套统计。状态一律认记录的工作流 status 字段（动作落库的那一份）。

// 指标名和状态对不上的别名（默认按「指标名包含状态文案」匹配）。
const STATUS_METRIC_ALIASES: Record<string, string> = {
  已出结果样品: '已完成',
  遗留问题总数: '',
}

// 需要做求和的指标：指标名 -> 取值字段；未登记的指标默认按状态计数。
const SUM_METRIC_FIELDS: Record<string, string> = {
  累计布方面积: '布方面积',
  遗留问题总数: '遗留问题数',
}

// 解析面积字段：空着/缺字段返回 null（待补，不拦截动作）；非法文本返回 NaN；正常返回数值。
export function parseArea(value: string | number | boolean | undefined): number | null {
  if (value === undefined || value === null) {
    return null
  }
  const text = String(value).trim()
  if (text === '') {
    return null
  }
  const match = text.match(/-?\d+(\.\d+)?/)
  if (!match) {
    return NaN
  }
  return Number(match[0])
}

export function countByStatus(rows: EntryRow[], status: string): number {
  return rows.filter((row) => String(row.status) === status).length
}

// 布方面积只累计有效（非负、可解析）的记录；空着待补与文本占位不计入。
export function totalArea(rows: EntryRow[]): number {
  return rows.reduce((sum, row) => {
    const area = parseArea(row['布方面积'])
    return area !== null && !Number.isNaN(area) && area >= 0 ? sum + area : sum
  }, 0)
}

export function sumField(rows: EntryRow[], field: string): number {
  return rows.reduce((sum, row) => {
    const value = Number(row[field])
    return Number.isFinite(value) ? sum + value : sum
  }, 0)
}

export function metricValue(meta: ModuleMeta, label: string, rows: EntryRow[]): number {
  const sumFieldName = SUM_METRIC_FIELDS[label]
  if (sumFieldName) {
    if (label === '累计布方面积') {
      return totalArea(rows)
    }
    return sumField(rows, sumFieldName)
  }
  if (STATUS_METRIC_ALIASES[label] === '') {
    return 0
  }
  const alias = STATUS_METRIC_ALIASES[label]
  const matchedStatus =
    alias ?? meta.statuses.find((status) => label.includes(status))
  return matchedStatus ? countByStatus(rows, matchedStatus) : 0
}

// 各模块页指标卡片与列表、概览取同一批记录。
export function moduleStats(
  meta: ModuleMeta,
  rows: EntryRow[],
): { label: string; value: number }[] {
  return meta.metrics.map((label) => ({ label, value: metricValue(meta, label, rows) }))
}
