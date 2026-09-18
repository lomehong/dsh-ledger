/**
 * dsh-ledger 客户端插件：在「插件」管理页注册本插件的配置区
 * （plugins.bundle.config，key=包名）。summary 一行简介；page 渲染账本只读速览
 * （裁决统计 / 活跃授权 / 待批审批 / 事后否决率 / 执行闸健康）。
 * 批准/驳回操作在「数字分身」今日待办与 HTTP API，此处不做第二操作入口。
 */
import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['slots']

interface LedgerStatsDto {
  total: number
  byStatus: Record<string, number>
  activeGrants?: number
  pendingApprovals?: number
  rejectedRate?: number | null
}
interface HealthDto {
  gateAttached?: boolean
  gateChannel?: string
  issues?: string[]
}
interface StatsResponse {
  ok: boolean
  stats?: LedgerStatsDto
  health?: HealthDto
  pending?: unknown[]
}

const c = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  sub: 'var(--dsw-alias-label-secondary, #4e5969)',
  faint: 'var(--dsw-alias-label-tertiary, #86909c)',
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  layer: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
  border: 'var(--dsw-alias-separator-primary, #e5e6eb)',
  ok: 'var(--dsw-alias-state-success-primary, #00b42a)',
  warn: 'var(--dsw-alias-state-warn-primary, #ff7d00)',
}

const sectionStyle = { border: `1px solid ${c.border}`, borderRadius: 8, padding: '12px 16px', background: c.bg, marginBottom: 12 }
const titleStyle = { fontSize: 13, fontWeight: 600, color: c.text, margin: '0 0 8px' }
const hintStyle = { fontSize: 12, color: c.sub, lineHeight: 1.5 }
const cellStyle = { padding: '10px 14px', borderRadius: 8, background: c.layer, textAlign: 'center' as const, minWidth: 84 }
const cellNumStyle = { fontSize: 20, fontWeight: 700, color: c.text }
const cellLabelStyle = { fontSize: 11.5, color: c.faint, marginTop: 2 }

/** 只读账本速览（有状态，由 React 渲染）。 */
function StatsPage(): JSX.Element {
  const [data, setData] = useState<StatsResponse | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/dsh-ledger/stats', { headers: { Accept: 'application/json' } })
      .then((r) => r.json() as Promise<StatsResponse>)
      .then((d) => {
        if (d.ok) setData(d)
        else setError(true)
      })
      .catch(() => setError(true))
  }, [])

  if (error) return <div style={{ ...hintStyle, color: c.warn }}>账本状态获取失败（dsh-ledger 宿主服务不可用？）。</div>
  if (data === null) return <div style={hintStyle}>加载账本状态中…</div>

  const s = data.stats
  const h = data.health
  const pendingCount = Array.isArray(data.pending) ? data.pending.length : (s?.pendingApprovals ?? 0)
  const cells: Array<[string, string | number]> = [
    ['账本记录', s?.total ?? 0],
    ['活跃授权', s?.activeGrants ?? 0],
    ['待批审批', pendingCount],
    ['事后否决率', s?.rejectedRate != null ? `${Math.round((s.rejectedRate as number) * 100)}%` : '—'],
  ]
  const byStatus = Object.entries(s?.byStatus ?? {})

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={sectionStyle}>
        <div style={titleStyle}>裁决统计</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {cells.map(([label, v]) => (
            <div key={label} style={cellStyle}>
              <div style={cellNumStyle}>{v}</div>
              <div style={cellLabelStyle}>{label}</div>
            </div>
          ))}
        </div>
        <div style={{ ...hintStyle, marginTop: 8 }}>
          {byStatus.length > 0 ? byStatus.map(([k, v]) => `${k}×${v}`).join(' · ') : '暂无记录'}
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ ...titleStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>执行闸（opt-in）</span>
          {h?.gateAttached === true ? (
            <span style={{ fontSize: 11.5, fontWeight: 600, color: c.ok }}>
              ✓ 已挂接{h.gateChannel !== undefined && h.gateChannel !== 'none' ? ` · ${h.gateChannel}` : ''}
            </span>
          ) : (
            <span style={{ fontSize: 11.5, fontWeight: 600, color: c.warn }}>未挂接（事件面缺席，账本仅记录不拦截）</span>
          )}
        </div>
        <div style={hintStyle}>
          只裁决显式声明 args.actionType 的工具调用（未知动作兜底 L2 fail-closed）；
          普通工作工具未声明治理意图，一律放行——主人日常会话全能力。
        </div>
        {h?.issues !== undefined && h.issues.length > 0 && (
          <div style={{ ...hintStyle, color: c.warn, marginTop: 6 }}>问题：{h.issues.join('；')}</div>
        )}
      </div>
    </div>
  )
}

/** 插件页配置入口：summary 一行简介（无 hooks）；page 渲染只读速览。 */
export function LedgerPluginConfig(props: { view: 'summary' | 'page' }): JSX.Element {
  if (props.view === 'page') return <StatsPage />
  return (
    <span style={{ fontSize: 12, color: c.sub }}>
      委托账本：L0–L3 分级裁决 · 审批令牌（3 分钟超时 fail-closed）· 结果回填；授权是数据，执行在机制。
    </span>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: '@dsh-extra/dsh-ledger' },
      (props: { view: 'summary' | 'page' }) => LedgerPluginConfig({ view: props.view }),
    ),
  )
}
