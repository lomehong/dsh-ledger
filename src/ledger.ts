/**
 * 委托账本核心（实施计划 T2/T6）
 *
 * 设计要点（对应设计文档 v0.2 决策二）：
 * - 每个可外发动作类型预置委托级别 L0/L1/L2/L3；未知动作类型默认 L2（fail-closed）
 * - 级别挂在动作类型上，不挂在对话者身份上——身份只影响信息可见性
 * - L2 的批准产生带范围与有效期的授权记录；授权是数据：可审计、可撤销、可过期
 * - 授权记录只能由批准通道写入（作者签名 = 通道），模型没有写账本的权限
 * - 每次放行回填结果记录，事后否决率成为账本原生数据
 * - 全部状态迁移追加 history（审计不覆盖）；记录只增不物理删
 *
 * 纯裁决层（decideLevel / grantCovers / judge / normalizeInput）与 IO 层分离：
 * 契约测试锁纯层行为；时钟可注入（测试 TTL 过期）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export type Level = 'L0' | 'L1' | 'L2' | 'L3'
export const LEVELS: readonly Level[] = ['L0', 'L1', 'L2', 'L3']

/** 默认委托级别表：动作类型 → 级别（策略卡 levelHint 可覆盖，但未知类型恒为 L2） */
export const DEFAULT_LEVELS: Record<string, Level> = {
  答疑: 'L0',
  检索: 'L0',
  寒暄: 'L0',
  日常应答: 'L0',
  代回消息: 'L1',
  调整日程: 'L1',
  发送消息: 'L1',
  对外承诺: 'L2',
  报价: 'L2',
  发布内容: 'L2',
  添加好友: 'L2',
  转账: 'L3',
  删除数据: 'L3',
  代主决策: 'L3',
  账号操作: 'L3',
}

/** 未知动作类型的兜底级别：fail-closed（没见过的动作需要批准） */
export const UNKNOWN_ACTION_LEVEL: Level = 'L2'

const LEVEL_ORDER: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3 }

/** 裁决动作类型级别；策略卡显式 levelHint 优先，未知动作类型兜底 L2 且不允许降级到 L2 以下 */
export function decideLevel(actionType: unknown, levelHint?: unknown): Level {
  const key = String(actionType ?? '').trim()
  const known = DEFAULT_LEVELS[key]
  const hint = typeof levelHint === 'string' && (LEVELS as readonly string[]).includes(levelHint) ? (levelHint as Level) : undefined
  if (known === undefined) {
    // 未知动作：基础 L2；显式 hint 只能升级不能降级
    return hint !== undefined && LEVEL_ORDER[hint] > LEVEL_ORDER[UNKNOWN_ACTION_LEVEL] ? hint : UNKNOWN_ACTION_LEVEL
  }
  if (hint !== undefined) {
    // 已知动作：hint 与默认取更严者（治理只能收紧不能放松——放松走策略卡修订）
    return LEVEL_ORDER[hint] >= LEVEL_ORDER[known] ? hint : known
  }
  return known
}

/** 授权记录（只能由批准通道创建；by = 通道签名而非模型声明） */
export interface Grant {
  id: string
  actionType: string
  targetScope: string
  by: string
  via: '审批卡片' | '命令' | 'web'
  createdAt: string
  expiresAt?: string
  revokedAt?: string
  revokeReason?: string
  /** 幂等键：同一批准事件重放不产生第二条授权 */
  idempotencyKey: string
  /** 来源被阻断记录（一键批准场景） */
  fromRecordId?: string
}

export type RecordStatus = '已放行' | '已阻断' | '已拒绝' | '已执行' | '已回填'
export type MasterFeedback = '认可' | '推翻' | '未评价'

export interface StatusEntry {
  status: RecordStatus
  at: string
  via: string
}

export interface LedgerRecord {
  id: string
  actionType: string
  level: Level
  actor?: { registryId?: string; channel?: string }
  target: { scope: string; digest?: string }
  status: RecordStatus
  /** 状态迁移历史（追加式审计） */
  history: StatusEntry[]
  authorization?: { grantId: string; via: string; by: string }
  outcome?: { at: string; summary: string; masterFeedback: MasterFeedback }
  createdAt: string
}

export interface Approval {
  id: string
  recordId: string
  actionType: string
  targetScope: string
  state: '待批准' | '已批准' | '已拒绝' | '已过期'
  createdAt: string
  expiresAt: string
  resolvedAt?: string
  by?: string
  via?: string
}

export interface LedgerStore {
  records: LedgerRecord[]
  grants: Grant[]
  approvals: Approval[]
}

export function ledgerHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function ledgerPath(): string {
  return join(ledgerHome(), 'dsh-ledger', 'ledger.json')
}

export function loadLedger(): LedgerStore {
  const path = ledgerPath()
  if (!existsSync(path)) return { records: [], grants: [], approvals: [] }
  try {
    const store = JSON.parse(readFileSync(path, 'utf8')) as LedgerStore
    return {
      records: Array.isArray(store.records) ? store.records : [],
      grants: Array.isArray(store.grants) ? store.grants : [],
      approvals: Array.isArray(store.approvals) ? store.approvals : [],
    }
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // 备份失败只能返回空
    }
    return { records: [], grants: [], approvals: [] }
  }
}

export function saveLedger(store: LedgerStore): void {
  const path = ledgerPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/* ── 可注入时钟（测试 TTL） ── */
let nowFn: () => Date = () => new Date()
export function setNowForTest(fn: () => Date): void {
  nowFn = fn
}
function now(): Date {
  return nowFn()
}

function genId(prefix: string): string {
  const d = now()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}-${ymd}-${Math.random().toString(36).slice(2, 7)}`
}

function digestOf(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16)
}

/* ── 纯裁决层 ── */

/** 授权是否覆盖（动作类型 + 范围）：scope='*' 通配；否则要求记录范围包含授权范围 */
export function grantCovers(grant: Grant, actionType: string, targetScope: string): boolean {
  if (grant.revokedAt !== undefined) return false
  if (grant.expiresAt !== undefined && grant.expiresAt <= now().toISOString()) return false
  if (grant.actionType !== actionType) return false
  if (grant.targetScope === '*') return true
  return targetScope.includes(grant.targetScope)
}

export type Decision = '放行' | '阻断' | '拒绝'

export interface Judgment {
  decision: Decision
  level: Level
  grant?: Grant
  reason: string
}

/** 纯裁决：给定级别与当前有效授权，判定放行/阻断/拒绝（无 IO，契约测试锁定） */
export function judge(level: Level, grants: Grant[], actionType: string, targetScope: string): Judgment {
  if (level === 'L3') {
    return { decision: '拒绝', level, reason: '禁区动作：无论谁问都只转达请求，账本拒绝执行' }
  }
  if (level === 'L0' || level === 'L1') {
    return { decision: '放行', level, reason: level === 'L0' ? '自主动作：做完留痕即可' : '通报动作：放行，完成后须通报主人并回填结果' }
  }
  const covering = grants.find(g => grantCovers(g, actionType, targetScope))
  if (covering !== undefined) {
    return { decision: '放行', level, grant: covering, reason: `命中授权 ${covering.id}（范围：${covering.targetScope}）` }
  }
  return { decision: '阻断', level, reason: '批准类动作且无覆盖范围的授权——先转人工征求主人批准' }
}

/* ── 输入归一化（白名单 + 清洗，入口唯一） ── */

export interface CheckInput {
  actionType: unknown
  actor?: { registryId?: unknown; channel?: unknown }
  targetScope: unknown
  digest?: unknown
  levelHint?: unknown
}

export interface NormalizedCheck {
  actionType: string
  targetScope: string
  level: Level
  actor?: { registryId?: string; channel?: string }
  digest?: string
}

export function normalizeCheckInput(input: CheckInput): NormalizedCheck {
  const actionType = String(input.actionType ?? '').trim().slice(0, 40)
  if (actionType === '') throw new Error('actionType 不能为空')
  const targetScope = String(input.targetScope ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 500)
  if (targetScope === '') throw new Error('targetScope 不能为空')
  const actor: { registryId?: string; channel?: string } = {}
  if (input.actor !== null && typeof input.actor === 'object') {
    const a = input.actor as { registryId?: unknown; channel?: unknown }
    if (typeof a.registryId === 'string' && a.registryId.trim() !== '') actor.registryId = a.registryId.trim().slice(0, 60)
    if (typeof a.channel === 'string' && a.channel.trim() !== '') actor.channel = a.channel.trim().toLowerCase().slice(0, 40)
  }
  const level = decideLevel(actionType, input.levelHint)
  const digest = input.digest === undefined ? undefined : String(input.digest).slice(0, 200)
  return {
    actionType,
    targetScope,
    level,
    ...(actor.registryId !== undefined || actor.channel !== undefined ? { actor } : {}),
    ...(digest !== undefined ? { digest } : {}),
  }
}

/* ── IO 层（读-改-写，状态迁移追加 history） ── */

function appendHistory(record: LedgerRecord, status: RecordStatus, via: string): void {
  record.status = status
  record.history.push({ status, at: now().toISOString(), via })
}

export interface CheckResult {
  record: LedgerRecord
  judgment: Judgment
  /** 阻断时生成的待批准令牌（转人工用，3 分钟 TTL） */
  approval?: Approval
}

/** 提交一次外发动作裁决（持久化记录 + 生成审批令牌） */
export function check(input: CheckInput, opts: { via?: string } = {}): CheckResult {
  const norm = normalizeCheckInput(input)
  const store = loadLedger()
  const judgment = judge(norm.level, store.grants, norm.actionType, norm.targetScope)
  const via = opts.via ?? '工具执行闸'
  const record: LedgerRecord = {
    id: genId('A'),
    actionType: norm.actionType,
    level: norm.level,
    ...(norm.actor !== undefined ? { actor: norm.actor } : {}),
    target: { scope: norm.targetScope, ...(norm.digest !== undefined ? { digest: norm.digest } : {}) },
    status: judgment.decision === '放行' ? '已放行' : judgment.decision === '阻断' ? '已阻断' : '已拒绝',
    history: [],
    createdAt: now().toISOString(),
    ...(judgment.grant !== undefined
      ? { authorization: { grantId: judgment.grant.id, via: judgment.grant.via, by: judgment.grant.by } }
      : {}),
  }
  appendHistory(record, record.status, via)

  let approval: Approval | undefined
  if (judgment.decision === '阻断') {
    approval = {
      id: genId('P'),
      recordId: record.id,
      actionType: norm.actionType,
      targetScope: norm.targetScope,
      state: '待批准',
      createdAt: now().toISOString(),
      expiresAt: new Date(now().getTime() + 3 * 60 * 1000).toISOString(),
    }
    store.approvals.push(approval)
  }
  store.records.push(record)
  saveLedger(store)
  return { record, judgment, ...(approval !== undefined ? { approval } : {}) }
}

export interface ResolveResult {
  ok: boolean
  record?: LedgerRecord
  grant?: Grant
  error?: string
}

/** 清理过期审批令牌（惰性；调用方在 approve/reject 前调用）。返回是否有变更需要保存 */
function expireApprovalsUnlocked(store: LedgerStore): boolean {
  const nowIso = now().toISOString()
  let changed = false
  for (const p of store.approvals) {
    if (p.state === '待批准' && p.expiresAt <= nowIso) {
      p.state = '已过期'
      p.resolvedAt = nowIso
      changed = true
      const record = store.records.find(r => r.id === p.recordId)
      if (record !== undefined && record.status === '已阻断') {
        appendHistory(record, '已拒绝', '审批超时 fail-closed')
      }
    }
  }
  return changed
}

/**
 * 批准：审批令牌 → 授权记录（机械落账，作者签名 = 通道）+ 记录放行。
 * 幂等：同一 approvalId 重复批准返回同一授权，不产生双记录。
 */
export function approve(
  approvalId: string,
  by: { by?: string; via?: '审批卡片' | '命令' | 'web' } = {},
  opts: { expiresInDays?: number } = {},
): ResolveResult {
  const store = loadLedger()
  const expired = expireApprovalsUnlocked(store)
  const approval = store.approvals.find(p => p.id === approvalId)
  if (approval === undefined) return { ok: false, error: '审批令牌不存在' }
  const via = by.via ?? '审批卡片'
  const actor = by.by ?? via
  if (approval.state === '已批准') {
    const grant = store.grants.find(g => g.idempotencyKey === approval.id)
    const record = store.records.find(r => r.id === approval.recordId)
    if (expired) saveLedger(store)
    return { ok: true, ...(record !== undefined ? { record } : {}), ...(grant !== undefined ? { grant } : {}) }
  }
  if (approval.state !== '待批准') {
    if (expired) saveLedger(store)
    return { ok: false, error: `审批令牌已处于「${approval.state}」状态` }
  }
  const record = store.records.find(r => r.id === approval.recordId)
  if (record === undefined) return { ok: false, error: '原记录不存在' }

  const days = Math.max(1, Math.min(365, opts.expiresInDays ?? 30))
  const grant: Grant = {
    id: genId('G'),
    actionType: approval.actionType,
    targetScope: approval.targetScope,
    by: actor,
    via,
    createdAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: approval.id,
    fromRecordId: approval.recordId,
  }
  store.grants.push(grant)
  approval.state = '已批准'
  approval.resolvedAt = now().toISOString()
  approval.by = actor
  approval.via = via
  record.authorization = { grantId: grant.id, via, by: actor }
  appendHistory(record, '已放行', `${via} 批准（授权 ${grant.id}）`)
  saveLedger(store)
  return { ok: true, record, grant }
}

/** 拒绝：记录终态「已拒绝」，不产生任何授权 */
export function rejectApproval(approvalId: string, by: { by?: string; via?: '审批卡片' | '命令' | 'web' } = {}): ResolveResult {
  const store = loadLedger()
  const expired = expireApprovalsUnlocked(store)
  const approval = store.approvals.find(p => p.id === approvalId)
  if (approval === undefined) return { ok: false, error: '审批令牌不存在' }
  const via = by.via ?? '审批卡片'
  if (approval.state === '已拒绝') {
    const record = store.records.find(r => r.id === approval.recordId)
    if (expired) saveLedger(store)
    return { ok: true, ...(record !== undefined ? { record } : {}) }
  }
  if (approval.state !== '待批准') {
    if (expired) saveLedger(store)
    return { ok: false, error: `审批令牌已处于「${approval.state}」状态` }
  }
  const record = store.records.find(r => r.id === approval.recordId)
  if (record === undefined) return { ok: false, error: '原记录不存在' }
  approval.state = '已拒绝'
  approval.resolvedAt = now().toISOString()
  approval.by = by.by ?? via
  approval.via = via
  appendHistory(record, '已拒绝', `${via} 拒绝`)
  saveLedger(store)
  return { ok: true, record }
}

/** 标记已执行（post-execute 钩）：工具真的跑完了 */
export function markExecuted(recordId: string): ResolveResult {
  const store = loadLedger()
  const record = store.records.find(r => r.id === recordId)
  if (record === undefined) return { ok: false, error: '记录不存在' }
  if (record.status !== '已放行') return { ok: false, error: `记录状态为「${record.status}」，不能标记执行` }
  appendHistory(record, '已执行', '工具执行完成')
  saveLedger(store)
  return { ok: true, record }
}

/**
 * 按动作匹配把最近一条「已放行」记录标记为已执行（tools/post-execute 钩子消费）。
 * 匹配口径与执行闸一致：actionType 精确匹配；targetScope 提供时一并校验。
 * 找不到匹配记录返回 ok=false（并非每次工具调用都过执行闸，属正常旁路）。
 */
export function markExecutedForAction(actionType: string, targetScope?: string): ResolveResult {
  const store = loadLedger()
  const candidates = store.records.filter(
    (r) => r.actionType === actionType && r.status === '已放行' && (targetScope === undefined || r.target.scope === targetScope),
  )
  const record = candidates[candidates.length - 1]
  if (record === undefined) return { ok: false, error: '无匹配的已放行记录' }
  appendHistory(record, '已执行', '工具执行完成')
  saveLedger(store)
  return { ok: true, record }
}

export interface OutcomeInput {
  summary: unknown
  masterFeedback?: unknown
  evidenceRef?: unknown
}

const FEEDBACKS: readonly MasterFeedback[] = ['认可', '推翻', '未评价']

/** 结果回填（决策二性质 4）：每次放行的动作执行后强制记录实际结果与主人反馈 */
export function fillResult(recordId: string, input: OutcomeInput): ResolveResult {
  const summary = String(input.summary ?? '').trim().slice(0, 500)
  if (summary === '') return { ok: false, error: '结果摘要不能为空' }
  const feedback = FEEDBACKS.includes(input.masterFeedback as MasterFeedback)
    ? (input.masterFeedback as MasterFeedback)
    : '未评价'
  const store = loadLedger()
  const record = store.records.find(r => r.id === recordId)
  if (record === undefined) return { ok: false, error: '记录不存在' }
  if (record.status !== '已放行' && record.status !== '已执行' && record.status !== '已回填') {
    return { ok: false, error: `记录状态为「${record.status}」，仅放行过的动作可回填结果` }
  }
  record.outcome = {
    at: now().toISOString(),
    summary,
    masterFeedback: feedback,
    ...(input.evidenceRef !== undefined ? { evidenceRef: String(input.evidenceRef).slice(0, 120) } : {}),
  }
  if (record.status !== '已回填') appendHistory(record, '已回填', '结果回填')
  saveLedger(store)
  return { ok: true, record }
}

/** 主人反馈更新（认可/推翻）：推翻记录自动成为策略卡修订的候选证据 */
export function feedback(recordId: string, masterFeedback: unknown, note?: unknown): ResolveResult {
  if (!FEEDBACKS.includes(masterFeedback as MasterFeedback)) {
    return { ok: false, error: 'masterFeedback 必须是 认可/推翻/未评价' }
  }
  const store = loadLedger()
  const record = store.records.find(r => r.id === recordId)
  if (record === undefined) return { ok: false, error: '记录不存在' }
  if (record.outcome === undefined) return { ok: false, error: '该记录尚未回填结果，请先 fillResult' }
  record.outcome.masterFeedback = masterFeedback as MasterFeedback
  if (note !== undefined) record.outcome.summary = `${record.outcome.summary}（${String(note).slice(0, 200)}）`
  saveLedger(store)
  return { ok: true, record }
}

export function revoke(grantId: string, reason: string): ResolveResult {
  const store = loadLedger()
  const grant = store.grants.find(g => g.id === grantId)
  if (grant === undefined) return { ok: false, error: '授权不存在' }
  if (grant.revokedAt === undefined) {
    grant.revokedAt = now().toISOString()
    grant.revokeReason = String(reason ?? '').slice(0, 200)
    saveLedger(store)
  }
  return { ok: true, grant }
}

export interface RecordFilter {
  actorId?: string
  actionType?: string
  status?: RecordStatus
  limit?: number
}

export function records(filter: RecordFilter = {}): LedgerRecord[] {
  const store = loadLedger()
  const out = store.records
    .filter(r => (filter.actorId !== undefined ? r.actor?.registryId === filter.actorId : true))
    .filter(r => (filter.actionType !== undefined ? r.actionType === filter.actionType : true))
    .filter(r => (filter.status !== undefined ? r.status === filter.status : true))
  return filter.limit !== undefined ? out.slice(-filter.limit) : out
}

export function grants(onlyActive = true): Grant[] {
  const store = loadLedger()
  const nowIso = now().toISOString()
  return store.grants.filter(g => (onlyActive ? g.revokedAt === undefined && (g.expiresAt === undefined || g.expiresAt > nowIso) : true))
}

export function pendingApprovals(): Approval[] {
  const store = loadLedger()
  expireApprovalsUnlocked(store)
  if (store.approvals.some(p => p.state === '已过期')) saveLedger(store)
  return store.approvals.filter(p => p.state === '待批准')
}

export interface LedgerStats {
  total: number
  byStatus: Record<RecordStatus, number>
  rejectedRate: number | null
  activeGrants: number
  pendingApprovals: number
}

/** 统计：事后否决率 = 推翻 / (认可 + 推翻)，仅对已回填且有主人反馈的记录计算 */
export function stats(): LedgerStats {
  const store = loadLedger()
  const byStatus: Record<RecordStatus, number> = { 已放行: 0, 已阻断: 0, 已拒绝: 0, 已执行: 0, 已回填: 0 }
  let approved = 0
  let overridden = 0
  for (const r of store.records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    if (r.outcome !== undefined && r.outcome.masterFeedback === '认可') approved += 1
    if (r.outcome !== undefined && r.outcome.masterFeedback === '推翻') overridden += 1
  }
  const feedbacked = approved + overridden
  return {
    total: store.records.length,
    byStatus,
    rejectedRate: feedbacked > 0 ? Number((overridden / feedbacked).toFixed(4)) : null,
    activeGrants: grants(true).length,
    pendingApprovals: pendingApprovals().length,
  }
}

/**
 * 启动自检（fail-closed 翻转：拦截器必须在位且裁决正确）。
 * 纯层自检：不触碰真实账本文件，验证裁决不变量。
 */
export function selfCheck(): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  const g: Grant = {
    id: 'G-selftest',
    actionType: '报价',
    targetScope: 'A 客户',
    by: '自检',
    via: 'web',
    createdAt: now().toISOString(),
    idempotencyKey: 'selftest',
  }
  if (judge('L2', [], '报价', 'A 客户').decision !== '阻断') issues.push('L2 无授权未阻断')
  if (judge('L2', [g], '报价', 'A 客户的询价').decision !== '放行') issues.push('L2 命中授权未放行')
  if (judge('L2', [g], '对外承诺', 'A 客户').decision !== '阻断') issues.push('授权串类型未隔离')
  if (judge('L3', [g], '转账', '任何').decision !== '拒绝') issues.push('L3 未拒绝')
  if (decideLevel('不认识的动作') !== 'L2') issues.push('未知动作类型未兜底 L2')
  if (decideLevel('转账') !== 'L3') issues.push('转账默认级别错误')
  return { ok: issues.length === 0, issues }
}
