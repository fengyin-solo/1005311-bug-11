import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, MetricRule, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 各模块 fields 最后一个就是业务状态列（如「探方状态」），动作流转时和规范字段 status 一起写，
// 列表用的那份和真正落库的那份从此出自同一条记录，不再各改各的。
function businessStatusField(meta: ModuleMeta): string {
  return meta.fields[meta.fields.length - 1]
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 字段里的数字：能解析成有限数就取值，空着或填了非数字（示例文本、待补）一律按未填对待，原样保留。
function numericValue(value: string | number | boolean | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') {
      return null
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// 模块动作的写入校验：当前只有探方的布方面积不允许负值落库。
// 缺字段不算错误（原样保留待补），只有明确填成负数这类非法值才拒绝写入。
function validateWrite(meta: ModuleMeta, row: EntryRow): string | null {
  if (meta.key === 'trench') {
    const area = numericValue(row['布方面积'])
    if (area !== null && area < 0) {
      return '布方面积不能为负值，请核实后再操作；缺面积可先留空待补'
    }
  }
  return null
}

// 统一的模块指标口径：概览卡片、模块列表统计都从这里取数，按同一份记录、同一套规则算。
export function moduleStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label) => {
    const rule = resolveMetricRule(meta, label)
    if (rule.kind === 'sum') {
      const total = rows.reduce((sum, row) => {
        const value = numericValue(row[rule.field])
        return value !== null ? sum + value : sum
      }, 0)
      return { label, value: total }
    }
    const value = rows.filter((row) => String(row.status) === rule.status).length
    return { label, value }
  })
}

function resolveMetricRule(meta: ModuleMeta, label: string): MetricRule {
  const explicit = meta.metricRules?.find((rule) => rule.label === label)
  if (explicit) {
    return explicit
  }
  // 兜底：指标名里带哪个状态就按哪个状态计数。
  const status = meta.statuses.find((item) => label.includes(item))
  if (status) {
    return { kind: 'status', label, status }
  }
  // 推断不出口径（如纯总量类指标），按 0 处理，避免页面再各写一套统计。
  return { kind: 'status', label, status: `__never__${label}` }
}

// 停掘结论回写到探方验收清单：每登记一次停掘，验收那边就多一条待核验收单。
function appendStopAcceptance(row: EntryRow): void {
  const rows = listRows('acceptance')
  const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const trenchCode = String(row['探方编号'] ?? row.id)
  const missing: string[] = []
  if (numericValue(row['布方面积']) === null) {
    missing.push('布方面积')
  }
  if (String(row['起始层位'] ?? '').trim() === '') {
    missing.push('起始层位')
  }
  const pendingNote = missing.length > 0 ? `；待补：${missing.join('、')}` : ''
  const entry: EntryRow = {
    id: nextId,
    status: '待验收',
    pending: true,
    abnormal: false,
    验收单号: `ACCE-STOP-${trenchCode}`,
    验收探方: trenchCode,
    验收类别: '停掘验收',
    验收人: '',
    验收日期: '',
    遗留问题数: 0,
    验收结论: `探方${trenchCode}已登记停掘，待现场核实后验收${pendingNote}`,
    验收状态: '待验收',
  }
  saveRows('acceptance', [...rows, entry])
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    [businessStatusField(meta)]: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 非法字段值不放行：记录原样不动，等补正后再流转；缺字段不拦，保留待补。
  const invalid = validateWrite(meta, updated)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 探方登记停掘：结论同步回写探方验收清单，验收侧随之多一条待核项。
  if (key === 'trench' && action === '登记停掘') {
    appendStopAcceptance(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    // 关键指标和列表页出自同一个 moduleStats，动作落库后两边数字一起变。
    const stats = moduleStats(meta.key)
    const keyLabel = meta.keyMetric ?? meta.metrics[0]
    const keyItem = stats.find((item) => item.label === keyLabel)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
      metricLabel: keyLabel,
      metricValue: keyItem?.value ?? 0,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
