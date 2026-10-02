import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { parseArea } from '@/data/stats'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 列表表格末列那份业务状态字段：它要和工作流 status 取同一份记录、同一次落库。
function statusField(meta: ModuleMeta): string | undefined {
  return [...meta.fields].reverse().find((field) => field.endsWith('状态'))
}

// 动作落库前的合法性校验：布方面积、起始层位缺着不拦（原样保留待补）；
// 布方面积填成负值这类非法值直接拦下，任何探方动作都不许带着它落库。
function validateTrenchArea(row: EntryRow, action: string): string | null {
  const area = parseArea(row['布方面积'])
  if (area !== null && !Number.isNaN(area) && area < 0) {
    return `布方面积不能为负值（当前为 ${String(row['布方面积']).trim()}），请改正后再${action}`
  }
  return null
}

// 停掘结论回写到探方验收清单：同一探方只补一条待核项，重复停掘不会重复回写。
function appendAcceptancePending(row: EntryRow): void {
  const acceptanceRows = listRows('acceptance')
  const trenchCode = String(row['探方编号'] ?? '')
  const exists = acceptanceRows.some(
    (item) => String(item['验收探方'] ?? '') === trenchCode && String(item['验收结论'] ?? '') === '停掘待核',
  )
  if (exists) {
    return
  }
  const nextId = acceptanceRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  const pendingItem: EntryRow = {
    id: nextId,
    status: '待验收',
    pending: true,
    abnormal: false,
    验收单号: `ACCE-${String(nextId).padStart(4, '0')}`,
    验收探方: trenchCode,
    验收类别: '停掘待核',
    验收人: '',
    验收日期: today,
    遗留问题数: 0,
    验收结论: '停掘待核',
    验收状态: '待验收',
  }
  saveRows('acceptance', [...acceptanceRows, pendingItem])
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
  const currentRow = rows[index]
  const current = String(currentRow.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 校验放在任何写入之前：不合法就整条动作不落库。
  if (key === 'trench') {
    const invalid = validateTrenchArea(currentRow, action)
    if (invalid) {
      return { ok: false, message: invalid }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const field = statusField(meta)
  // 工作流状态与列表业务状态写的是同一条记录、同一次落库，概览与列表从此同源。
  const updated: EntryRow = {
    ...currentRow,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    ...(field ? { [field]: target } : {}),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 停掘结论回写到探方验收清单，验收那边随之多一条待核项；历史记录不在此处补算。
  if (key === 'trench' && action === '登记停掘') {
    appendAcceptancePending(updated)
  }
  const acceptanceNote =
    key === 'trench' && action === '登记停掘' ? '，已在探方验收清单登记一条停掘待核项' : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${acceptanceNote}` }
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
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
