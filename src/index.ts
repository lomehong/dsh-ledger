/**
 * dsh-ledger — 委托账本插件（实施计划 T2/T6）
 *
 * 核心（裁决 + 存储）在 ./ledger.ts；本文件是宿主胶水：
 * - provide('dsh-ledger') 服务
 * - 防御性挂接工具执行闸（tools/pre-execute waterfall；宿主不提供事件面时
 *   记入 health.issues 并告警——fail-closed 翻转：拦截器失效绝不静默放行）
 * - 可选 webServer 路由：记录/统计/批准/拒绝/结果回填/主人反馈
 *
 * 纪律：apply() 全路径防御（LESSONS #2）；写端点 sameOrigin + JSON + 体积上限。
 */
import {
  approve,
  check,
  feedback,
  fillResult,
  grants,
  judge,
  loadLedger,
  markExecuted,
  normalizeCheckInput,
  pendingApprovals,
  records,
  rejectApproval,
  markExecutedForAction,
  revoke,
  selfCheck,
  setNowForTest,
  stats,
  type CheckInput,
} from './ledger.ts'

export const name = 'dsh-ledger'
export const provide = ['dsh-ledger']

interface RequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, cb: (chunk: Buffer) => void): void
  resume(): void
  destroy(): void
}
interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}
interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: RequestLike, res: ResponseLike) => void | Promise<void> }): () => void
  effect?(fn: () => () => void): void
}

const BODY_LIMIT = 64 * 1024

function readJsonBody(req: RequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '')
    if (!/application\/json/i.test(ct)) {
      reject(new Error('content-type must be application/json'))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const all = Buffer.concat(chunks).toString('utf8')
        resolve(all ? JSON.parse(all) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sameOrigin(req: RequestLike): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(String(origin)).host === host
  } catch {
    return false
  }
}

function respondJson(res: ResponseLike, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

interface Health {
  gateAttached: boolean
  gateChannel: string
  issues: string[]
  startedAt: string
}

export function apply(ctx: unknown): void {
  const c = ctx as {
    logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }
    provide?: (name: string, value: unknown) => void
    inject?: (deps: string[], fn: (wctx: unknown) => void) => void
    get?: (name: string) => unknown
    on?: (event: string, handler: (payload: unknown) => unknown) => unknown
  }
  const log = (fn?: (...a: unknown[]) => void, ...a: unknown[]) => {
    try {
      fn?.(...a)
    } catch {
      // 日志失败忽略
    }
  }
  log(c.logger?.info, '[dsh-ledger] 委托账本已加载')

  // 启动自检：裁决不变量任一破坏都告警（自检不过 = 账本不可信）
  const sc = selfCheck()
  const health: Health = {
    gateAttached: false,
    gateChannel: 'none',
    issues: sc.ok ? [] : ['自检失败：' + sc.issues.join('；')],
    startedAt: new Date().toISOString(),
  }
  if (!sc.ok) log(c.logger?.warn, '[dsh-ledger] 自检失败:', sc.issues.join('；'))

  const service = {
    check: (input: CheckInput, opts?: { via?: string }) => check(input, opts),
    normalizeCheckInput,
    judge,
    approve,
    rejectApproval,
    markExecuted,
    fillResult,
    feedback,
    revoke,
    records,
    grants,
    pendingApprovals,
    stats,
    selfCheck,
    setNowForTest,
    loadLedger,
    health: (): Health => health,
  }
  try {
    c.provide?.('dsh-ledger', service)
  } catch (e) {
    log(c.logger?.warn, '[dsh-ledger] provide 失败:', e instanceof Error ? e.message : String(e))
  }

  // 执行闸：防御性挂接 tools/pre-execute waterfall。
  // 宿主事件面形态可能变化：挂接失败绝不静默——记入 health.issues 并告警。
  try {
    if (typeof c.on === 'function') {
      const handler = (payload: unknown) => {
        // 事件载荷：{ tool, args }（结构化视图；字段缺失时放行并留痕，闸门兜底在服务侧）
        const p = payload as { tool?: unknown; args?: Record<string, unknown> } | undefined
        const actionType = typeof p?.args?.actionType === 'string' ? (p.args.actionType as string) : typeof p?.tool === 'string' ? p.tool : ''
        if (actionType === '') return { action: 'allow' as const }
        const args = (p?.args ?? {}) as Record<string, unknown>
        const input: CheckInput = {
          actionType,
          targetScope: typeof args.targetScope === 'string' ? args.targetScope : actionType,
        }
        const actor: { registryId?: string; channel?: string } = {}
        if (typeof args.registryId === 'string') actor.registryId = args.registryId
        if (typeof args.channel === 'string') actor.channel = args.channel
        if (actor.registryId !== undefined || actor.channel !== undefined) input.actor = actor
        if (typeof args.levelHint === 'string') input.levelHint = args.levelHint
        const result = check(input)
        if (result.judgment.decision === '放行') return { action: 'allow' as const, recordId: result.record.id }
        return {
          action: 'deny' as const,
          recordId: result.record.id,
          approvalId: result.approval?.id,
          message: result.judgment.reason,
        }
      }
      c.on('tools/pre-execute', handler)
      health.gateAttached = true
      health.gateChannel = 'tools/pre-execute'
      log(c.logger?.info, '[dsh-ledger] 执行闸已挂接 tools/pre-execute')
    } else {
      health.issues.push('宿主未提供事件面（ctx.on），执行闸未挂接——账本仅记录不拦截')
      log(c.logger?.warn, '[dsh-ledger] 宿主未提供事件面，执行闸未挂接')
    }
  } catch (e) {
    health.issues.push('执行闸挂接异常：' + (e instanceof Error ? e.message : String(e)))
    log(c.logger?.warn, '[dsh-ledger] 执行闸挂接异常:', e instanceof Error ? e.message : String(e))
  }

  // 执行后留痕：把「已放行 → 已执行」状态闭环（宪章第二阶段挂链）。
  // 只在工具成功时标记（isError 不留执行态）；无匹配记录时静默——
  // 并非每次工具调用都经过执行闸（未声明 actionType 的旁路调用）。
  try {
    if (typeof c.on === 'function') {
      // 该仓库的 cordis 泛型未声明本事件的 (exec, result, next) 三参形态——宽松挂接
      const onPost = c.on as unknown as (event: string, listener: (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) => void
      onPost('tools/post-execute', async (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
        try {
          const e2 = exec as { name?: unknown; args?: Record<string, unknown> } | undefined
          const r2 = result as { isError?: unknown } | undefined
          if (r2?.isError !== true) {
            const args = (e2?.args ?? {}) as Record<string, unknown>
            const actionType = typeof args.actionType === 'string' ? args.actionType : typeof e2?.name === 'string' ? e2.name : ''
            if (actionType !== '') {
              const targetScope = typeof args.targetScope === 'string' ? args.targetScope : undefined
              const marked = markExecutedForAction(actionType, targetScope)
              if (!marked.ok && marked.error !== '无匹配的已放行记录') {
                log(c.logger?.warn, '[dsh-ledger] 执行留痕失败:', marked.error ?? '')
              }
            }
          }
        } catch { /* 留痕失败不影响工具结果 */ }
        return await next()
      })
      health.gateChannel = 'tools/pre-execute + tools/post-execute'
      log(c.logger?.info, '[dsh-ledger] 执行留痕已挂接 tools/post-execute')
    }
  } catch (e) {
    health.issues.push('执行留痕挂接异常：' + (e instanceof Error ? e.message : String(e)))
    log(c.logger?.warn, '[dsh-ledger] 执行留痕挂接异常:', e instanceof Error ? e.message : String(e))
  }

  // 管理路由（可选）
  try {
    c.inject?.(['webServer'], (wctx: unknown) => {
      const web = (wctx as { get?: (n: string) => unknown }).get?.('webServer') as WebServerLike | undefined
      if (web === undefined || typeof web.register !== 'function') return
      const disposers: Array<() => void> = []

      disposers.push(
        web.register({
          kind: 'exact',
          path: '/dsh-ledger/stats',
          handler: (_req, res) => {
            respondJson(res, 200, { ok: true, stats: stats(), health, pending: pendingApprovals() })
          },
        }),
      )
      disposers.push(
        web.register({
          kind: 'exact',
          path: '/dsh-ledger/records',
          handler: (req, res) => {
            const url = new URL(req.headers.host !== undefined ? `http://${String(req.headers.host)}${req.url ?? '/'}` : 'http://local/')
            const filter: { actionType?: string; status?: never; limit?: number } = {}
            const at = url.searchParams.get('actionType')
            if (at !== null && at !== '') filter.actionType = at
            const lim = url.searchParams.get('limit')
            if (lim !== null && lim !== '' && Number.isFinite(Number(lim))) filter.limit = Number(lim)
            respondJson(res, 200, {
              ok: true,
              records: records(filter),
              activeGrants: grants(true),
            })
          },
        }),
      )
      disposers.push(
        web.register({
          kind: 'exact',
          path: '/dsh-ledger/approve',
          handler: async (req, res) => {
            if (req.method !== 'POST' || !sameOrigin(req)) {
              respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' })
              return
            }
            try {
              const body = (await readJsonBody(req)) as { approvalId?: string; via?: string; expiresInDays?: number }
              const r = approve(
                String(body.approvalId ?? ''),
                { via: body.via === '命令' || body.via === 'web' ? body.via : '审批卡片' },
                body.expiresInDays !== undefined ? { expiresInDays: body.expiresInDays } : {},
              )
              respondJson(res, r.ok ? 200 : 400, r)
            } catch (e) {
              respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          },
        }),
      )
      disposers.push(
        web.register({
          kind: 'exact',
          path: '/dsh-ledger/reject',
          handler: async (req, res) => {
            if (req.method !== 'POST' || !sameOrigin(req)) {
              respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' })
              return
            }
            try {
              const body = (await readJsonBody(req)) as { approvalId?: string; via?: string }
              const r = rejectApproval(String(body.approvalId ?? ''), { via: body.via === '命令' || body.via === 'web' ? body.via : '审批卡片' })
              respondJson(res, r.ok ? 200 : 400, r)
            } catch (e) {
              respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          },
        }),
      )
      disposers.push(
        web.register({
          kind: 'exact',
          path: '/dsh-ledger/result',
          handler: async (req, res) => {
            if (req.method !== 'POST' || !sameOrigin(req)) {
              respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' })
              return
            }
            try {
              const body = (await readJsonBody(req)) as { recordId?: string; summary?: unknown; masterFeedback?: unknown; feedbackOnly?: boolean }
              const r =
                body.feedbackOnly === true
                  ? feedback(String(body.recordId ?? ''), body.masterFeedback, body.summary)
                  : fillResult(String(body.recordId ?? ''), { summary: body.summary, masterFeedback: body.masterFeedback })
              // v2 学习闭环：否决信号软依赖入队（dsh-twin 在位时；缺失静默跳过）
              if (r.ok && body.masterFeedback === '推翻') {
                try {
                  const twin = c.get?.('dsh-twin') as { enqueueLearning?: (i: unknown) => unknown } | undefined
                  const rec = r.record
                  twin?.enqueueLearning?.({
                    kind: '否决',
                    target: '策略卡',
                    signal: `${rec?.actionType ?? '动作'}：${rec?.target?.scope ?? ''} 被主人推翻`,
                    ref: rec?.id,
                    by: '主人',
                  })
                } catch {
                  // 学习闭环缺席不阻断账本反馈
                }
              }
              respondJson(res, r.ok ? 200 : 400, r)
            } catch (e) {
              respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          },
        }),
      )

      if (typeof web.effect === 'function') {
        web.effect(() => () => {
          for (const d of disposers) d()
        })
      }
      log(c.logger?.info, '[dsh-ledger] 管理路由已注册 (/dsh-ledger/*)')
    })
  } catch (e) {
    log(c.logger?.warn, '[dsh-ledger] webServer 注入失败（不影响核心服务）:', e instanceof Error ? e.message : String(e))
  }
}

export {
  approve,
  check,
  decideLevel,
  feedback,
  fillResult,
  grantCovers,
  grants,
  judge,
  loadLedger,
  markExecuted,
  normalizeCheckInput,
  pendingApprovals,
  records,
  rejectApproval,
  revoke,
  selfCheck,
  stats,
} from './ledger.ts'
export type { Approval, Decision, Grant, Judgment, LedgerRecord, Level, RecordStatus } from './ledger.ts'
