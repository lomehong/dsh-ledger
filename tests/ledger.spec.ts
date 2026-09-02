/**
 * dsh-ledger 契约测试：锁定治理行为本身。
 * - L2 无授权必阻断、批准后放行、授权串类型隔离、L3 恒拒绝
 * - 批准幂等（同一 approvalId 不产生双授权）
 * - 审批 3 分钟 TTL fail-closed（超时 = 已拒绝）
 * - 授权可撤销、可过期；撤销后同类动作再次阻断
 * - 结果回填与事后否决率从账本原生计算
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Grant } from '../src/ledger.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ledger-test-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

async function L() {
  return import('../src/ledger.ts')
}

describe('纯裁决层（decideLevel / judge）', () => {
  it('已知动作类型走默认级别；未知动作兜底 L2', async () => {
    const { decideLevel } = await L()
    expect(decideLevel('答疑')).toBe('L0')
    expect(decideLevel('代回消息')).toBe('L1')
    expect(decideLevel('对外承诺')).toBe('L2')
    expect(decideLevel('转账')).toBe('L3')
    expect(decideLevel('从没见过的动作')).toBe('L2')
  })

  it('levelHint 只能收紧不能放松', async () => {
    const { decideLevel } = await L()
    expect(decideLevel('答疑', 'L2')).toBe('L2') // 收紧生效
    expect(decideLevel('对外承诺', 'L0')).toBe('L2') // 放松被拒
    expect(decideLevel('不认识的动作', 'L3')).toBe('L3') // 未知动作可收紧
    expect(decideLevel('不认识的动作', 'L0')).toBe('L2') // 不可放松
  })

  it('L2 无授权阻断；命中覆盖授权放行；授权串类型隔离', async () => {
    const { judge } = await L()
    const g = {
      id: 'G-1', actionType: '报价', targetScope: 'A 客户', by: '主人', via: '审批卡片' as const,
      createdAt: '2026-01-01T00:00:00Z', idempotencyKey: 'k1',
    } satisfies Grant
    expect(judge('L2', [], '报价', 'A 客户').decision).toBe('阻断')
    const j = judge('L2', [g], '报价', 'A 客户的询价')
    expect(j.decision).toBe('放行') // 记录范围包含授权范围
    expect(j.grant?.id).toBe('G-1')
    expect(judge('L2', [g], '对外承诺', 'A 客户').decision).toBe('阻断') // 类型不同不覆盖
    expect(judge('L2', [g], '报价', 'B 客户').decision).toBe('阻断') // 范围不含
  })

  it('L3 恒拒绝，即使存在授权', async () => {
    const { judge } = await L()
    const g = {
      id: 'G-2', actionType: '转账', targetScope: '*', by: 'x', via: 'web' as const,
      createdAt: '2026-01-01T00:00:00Z', idempotencyKey: 'k2',
    } satisfies Grant
    expect(judge('L3', [g], '转账', '任何').decision).toBe('拒绝')
  })

  it('已撤销 / 已过期的授权不再覆盖', async () => {
    const { judge, setNowForTest } = await L()
    const base = {
      id: 'G-3', actionType: '报价', targetScope: '*', by: 'x', via: 'web' as const,
      createdAt: '2026-01-01T00:00:00Z', idempotencyKey: 'k3',
    }
    setNowForTest(() => new Date('2026-06-01T00:00:00Z'))
    const revoked: Grant = { ...base, revokedAt: '2026-05-01T00:00:00Z', revokeReason: '测试' }
    expect(judge('L2', [revoked], '报价', '任何人').decision).toBe('阻断')
    const expired: Grant = { ...base, expiresAt: '2026-05-01T00:00:00Z' }
    expect(judge('L2', [expired], '报价', '任何人').decision).toBe('阻断')
    setNowForTest(() => new Date())
  })
})

describe('IO 层（check / approve / 结果回填）', () => {
  it('L0/L1 直接放行并留痕；L2 无授权阻断 + 生成 3 分钟审批令牌；L3 拒绝', async () => {
    const { check } = await L()
    const l0 = check({ actionType: '答疑', targetScope: '访客提问' })
    expect(l0.record.status).toBe('已放行')
    const l1 = check({ actionType: '代回消息', targetScope: '客户消息', actor: { registryId: 'act_1', channel: 'wecom' } })
    expect(l1.record.status).toBe('已放行')
    expect(l1.record.actor?.registryId).toBe('act_1')

    const l2 = check({ actionType: '对外承诺', targetScope: '对 A 客户承诺交付' })
    expect(l2.record.status).toBe('已阻断')
    expect(l2.approval).toBeDefined()
    expect(l2.approval!.state).toBe('待批准')

    const l3 = check({ actionType: '转账', targetScope: '向 X 转账' })
    expect(l3.record.status).toBe('已拒绝')
    expect(l3.approval).toBeUndefined()
  })

  it('批准 → 授权落账 → 同类动作自动放行；批准幂等', async () => {
    const { check, approve, grants } = await L()
    const blocked = check({ actionType: '报价', targetScope: '对 A 客户报价' })
    const approvalId = blocked.approval!.id

    const first = approve(approvalId, { via: '审批卡片', by: 'wecom:boss' })
    expect(first.ok).toBe(true)
    expect(first.record!.status).toBe('已放行')
    expect(first.grant).toBeDefined()

    // 幂等：重复批准同一令牌不产生双授权
    const again = approve(approvalId, { via: '审批卡片', by: 'wecom:boss' })
    expect(again.ok).toBe(true)
    expect(grants(true).filter(g => g.idempotencyKey === approvalId).length).toBe(1)

    // 同类动作命中授权自动放行
    const again2 = check({ actionType: '报价', targetScope: '对 A 客户报价（更新版）' })
    expect(again2.record.status).toBe('已放行')
    expect(again2.record.authorization?.grantId).toBe(first.grant!.id)
    // 非同类仍阻断
    expect(check({ actionType: '对外承诺', targetScope: '对 A 客户承诺' }).record.status).toBe('已阻断')
  })

  it('审批超时 fail-closed：过期令牌批准失败，记录转已拒绝', async () => {
    const { check, approve, setNowForTest, records } = await L()
    const blocked = check({ actionType: '发布内容', targetScope: '公众号文章' })
    const token = blocked.approval!
    expect(new Date(token.expiresAt).getTime() - new Date(token.createdAt).getTime()).toBe(3 * 60 * 1000)

    setNowForTest(() => new Date(Date.now() + 4 * 60 * 1000))
    const late = approve(token.id, { via: '审批卡片' })
    expect(late.ok).toBe(false)
    // 惰性过期已把记录转终态（从账本重读验证，而非持有旧对象引用）
    expect(records({ actionType: '发布内容' })[0]!.status).toBe('已拒绝')
    setNowForTest(() => new Date())
  })

  it('拒绝审批：记录终态已拒绝，不产生授权', async () => {
    const { check, rejectApproval, grants } = await L()
    const blocked = check({ actionType: '发布内容', targetScope: 'X' })
    const r = rejectApproval(blocked.approval!.id, { via: '命令' })
    expect(r.ok).toBe(true)
    expect(r.record!.status).toBe('已拒绝')
    expect(grants(true).length).toBe(0)
  })

  it('撤销授权后，同类动作再次阻断', async () => {
    const { check, approve, grants, revoke } = await L()
    const blocked = check({ actionType: '报价', targetScope: '对 B 客户报价' })
    const approved = approve(blocked.approval!.id, { via: 'web' })
    expect(approved.ok).toBe(true)
    const grantId = approved.grant!.id
    expect(revoke(grantId, '范围过大').ok).toBe(true)
    expect(check({ actionType: '报价', targetScope: '对 B 客户报价' }).record.status).toBe('已阻断')
  })
})

describe('结果回填与事后否决率（T6）', () => {
  it('放行 → 执行 → 回填 全生命周期；未放行动作不可回填', async () => {
    const { check, markExecuted, fillResult } = await L()
    const l0 = check({ actionType: '答疑', targetScope: 'q' })
    const ex = markExecuted(l0.record.id)
    expect(ex.ok).toBe(true)
    const fill = fillResult(l0.record.id, { summary: '已解答', masterFeedback: '认可' })
    expect(fill.ok).toBe(true)
    expect(fill.record!.status).toBe('已回填')

    const blocked = check({ actionType: '对外承诺', targetScope: 'x' })
    expect(fillResult(blocked.record.id, { summary: '不该有结果' }).ok).toBe(false)
  })

  it('事后否决率 = 推翻/(认可+推翻)，从账本直接算出', async () => {
    const { check, markExecuted, fillResult, feedback, stats } = await L()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = check({ actionType: '代回消息', targetScope: `消息${i}` })
      markExecuted(r.record.id)
      fillResult(r.record.id, { summary: `结果${i}`, masterFeedback: i < 3 ? '认可' : '推翻' })
      ids.push(r.record.id)
    }
    // 第 4 条主人改主意：推翻已是终态可更新
    feedback(ids[3]!, '推翻', '客户说没答应过')
    const s = stats()
    expect(s.byStatus['已回填']).toBe(4)
    expect(s.rejectedRate).toBe(0.25)
  })

  it('输入归一化：空 actionType/targetScope 拒绝，控制字符清洗，超限截断', async () => {
    const { check, normalizeCheckInput } = await L()
    expect(() => check({ actionType: '', targetScope: 'x' })).toThrow()
    expect(() => check({ actionType: '答疑', targetScope: '' })).toThrow()
    const n = normalizeCheckInput({ actionType: ' 答疑 ', targetScope: '  a\u0000b  '.replace(/\u0000/g, ' ') })
    expect(n.actionType).toBe('答疑')
    expect(n.targetScope).toBe('a b')
    const long = 'x'.repeat(600)
    expect(normalizeCheckInput({ actionType: '答疑', targetScope: long }).targetScope.length).toBe(500)
  })
})

describe('持久化与自检', () => {
  it('记录跨加载持久化；history 追加式审计', async () => {
    const { check, approve, records } = await L()
    const blocked = check({ actionType: '报价', targetScope: 'C 客户' })
    approve(blocked.approval!.id, { via: '审批卡片' })
    const after = records({ actionType: '报价' })
    expect(after.length).toBe(1)
    expect(after[0]!.history.map(h => h.status)).toEqual(['已阻断', '已放行'])
  })

  it('启动自检：裁决不变量全部成立', async () => {
    const { selfCheck } = await L()
    const sc = selfCheck()
    expect(sc.ok).toBe(true)
    expect(sc.issues).toEqual([])
  })
})
