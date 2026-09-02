/**
 * v1 端到端冒烟剧本（实施计划 T8）：
 * 访客问报价 → 账本阻断转人工 → 主人卡片批准（机械落账）→ 分身放行答复
 * → 执行结果回填 → 主人推翻 → 否决记录入账 → 否决率从账本算出
 *
 * 全程机制参与、零模型参与（账本/注册表核心直接驱动）。
 * 运行前必须设置 USERPROFILE 指向全新临时目录：
 *   USERPROFILE=<tmp> node scripts/smoke-v1.mjs
 */
import { provision, bindMaster, resolve } from 'file:///D:/development/Coder/nodejs/dsh/dsh-actors/lib/registry.js'
import { check, approve, markExecuted, fillResult, feedback, stats, records } from 'file:///D:/development/Coder/nodejs/dsh/dsh-ledger/lib/ledger.js'
import { runRegression } from 'file:///D:/development/Coder/nodejs/dsh/dsh-regression/lib/runner.js'
import { createScriptedRunner } from 'file:///D:/development/Coder/nodejs/dsh/dsh-regression/lib/index.js'

let failed = 0
function check2(name, cond, extra = '') {
  if (cond) { console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) }
}

console.log('== 剧本：访客询价（企微渠道） ==')

// ① 对话者注册：未注册访客按「生人」fail-closed 供给
const guest = provision('wecom', 'wx-cust-88', '客户 A')
check2('访客实体已注册（角色=生人）', guest.entity.role === 'stranger')
const master = bindMaster('wecom', 'wx-boss-01')
check2('主人已认领（全局唯一）', master.ok && master.entity.role === 'master')
check2('冒充主人者不会提权', resolve('wecom', 'wx-cust-88').role === 'stranger')

// ② 访客要求分身承诺交付 → 账本 L2 阻断 + 转人工
const attempt = check({
  actionType: '对外承诺',
  targetScope: '对客户 A 承诺两周内交付',
  actor: { registryId: guest.entity.id, channel: 'wecom' },
})
check2('承诺类动作被账本阻断', attempt.record.status === '已阻断')
check2('生成 3 分钟审批令牌', attempt.approval !== undefined && attempt.approval.state === '待批准')

// ③ 主人在审批卡片点「批准」→ 机械落账（通道签名，非模型声明）
const approval = approve(attempt.approval.id, { via: '审批卡片', by: 'wecom:wx-boss-01' }, { expiresInDays: 7 })
check2('批准后记录放行', approval.ok && approval.record.status === '已放行')
check2('授权记录作者=通道签名', approval.grant.via === '审批卡片' && approval.grant.by === 'wecom:wx-boss-01')

// ④ 同类动作再发生 → 命中授权自动放行（无需再次打扰主人）
const again = check({
  actionType: '对外承诺',
  targetScope: '对客户 A 承诺两周内交付（补充说明）',
  actor: { registryId: guest.entity.id, channel: 'wecom' },
})
check2('同类动作命中授权自动放行', again.record.status === '已放行')

// ⑤ 执行完成 → 结果回填 → 主人推翻（事后否决）
markExecuted(attempt.record.id)
fillResult(attempt.record.id, { summary: '已向客户 A 承诺两周交付', masterFeedback: '未评价' })
feedback(attempt.record.id, '推翻', '主人否决：产能不足不能承诺')
check2('否决反馈已入账', records({}).find(r => r.id === attempt.record.id).outcome.masterFeedback === '推翻')

// ⑥ 否决率从账本原生算出（此刻 1/2 = 0.5：一笔推翻、一笔认可）
fillResult(again.record.id, { summary: '补充说明已发送', masterFeedback: '认可' })
const s = stats()
check2('事后否决率=0.5（账本原生）', s.rejectedRate === 0.5)

// ⑦ 回归 runner（Scripted）：机制一致性全绿
const report = await runRegression({ runner: createScriptedRunner() })
check2('人格回归 20/20 通过（机制一致性）', report.total === 20 && report.failed === 0)

console.log(failed === 0 ? '\n端到端剧本全部通过 ✓' : `\n${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
