# dsh-ledger — 委托账本

数字分身的权限内核（实施计划 T2/T6）：L0–L3 委托级别裁决、授权记录（批准通道
机械落账）、执行闸、结果回填与事后否决率统计。

## 治理不变量

1. **级别挂在动作类型上**，不挂在对话者身份上——承诺类动作对任何人都需要批准。
2. **未知动作类型兜底 L2**（fail-closed）；策略卡 levelHint 只能收紧不能放松。
3. **授权记录只能由批准通道写入**（作者签名 = 通道），模型没有写账本的权限。
4. **L2 无授权 → 阻断 + 3 分钟审批令牌**；超时 fail-closed 自动转已拒绝。
5. **每次放行回填结果记录**——事后否决率是账本原生数据（推翻/(认可+推翻)）。

## 数据

`$DSH_HOME/dsh-ledger/ledger.json`（0600，原子写；记录只增不物理删，状态迁移
追加 history 审计）。

## HTTP 路由（可选，webServer 注入）

`GET /dsh-ledger/stats` · `GET /dsh-ledger/records` · `POST /dsh-ledger/approve`
· `POST /dsh-ledger/reject` · `POST /dsh-ledger/result`（feedbackOnly=true 时仅
更新主人反馈）。写端点 sameOrigin。

## 执行闸

`tools/pre-execute` waterfall 防御性挂接；宿主事件面缺失或挂接异常时记入
`health.issues` 并告警（**绝不静默放行**）。启动自检 `selfCheck()` 验证裁决
不变量（L2 阻断 / 授权覆盖 / 类型隔离 / L3 拒绝 / 未知兜底）。

## 端到端冒烟

```sh
USERPROFILE=<全新临时目录> node scripts/smoke-v1.mjs
```

剧本：访客问报价 → 阻断转人工 → 主人批准 → 授权放行 → 结果回填 → 主人推翻 →
否决率 0.5 从账本算出 → 人格回归 20/20。

## 开发

```sh
npm test        # vitest 直跑 src（15 用例）
npm run build   # tsc → lib/
```

## 许可

MIT
