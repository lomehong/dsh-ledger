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
import { approve, check, feedback, fillResult, grants, judge, loadLedger, markExecuted, normalizeCheckInput, pendingApprovals, records, rejectApproval, revoke, selfCheck, setNowForTest, stats, } from "./ledger.js";
export const name = 'dsh-ledger';
export const provide = ['dsh-ledger'];
const BODY_LIMIT = 64 * 1024;
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const ct = String(req.headers['content-type'] ?? '');
        if (!/application\/json/i.test(ct)) {
            reject(new Error('content-type must be application/json'));
            req.resume();
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > BODY_LIMIT) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                const all = Buffer.concat(chunks).toString('utf8');
                resolve(all ? JSON.parse(all) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '')
        return false;
    try {
        return new URL(String(origin)).host === host;
    }
    catch {
        return false;
    }
}
function respondJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
}
export function apply(ctx) {
    const c = ctx;
    const log = (fn, ...a) => {
        try {
            fn?.(...a);
        }
        catch {
            // 日志失败忽略
        }
    };
    log(c.logger?.info, '[dsh-ledger] 委托账本已加载');
    // 启动自检：裁决不变量任一破坏都告警（自检不过 = 账本不可信）
    const sc = selfCheck();
    const health = {
        gateAttached: false,
        gateChannel: 'none',
        issues: sc.ok ? [] : ['自检失败：' + sc.issues.join('；')],
        startedAt: new Date().toISOString(),
    };
    if (!sc.ok)
        log(c.logger?.warn, '[dsh-ledger] 自检失败:', sc.issues.join('；'));
    const service = {
        check: (input, opts) => check(input, opts),
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
        health: () => health,
    };
    try {
        c.provide?.('dsh-ledger', service);
    }
    catch (e) {
        log(c.logger?.warn, '[dsh-ledger] provide 失败:', e instanceof Error ? e.message : String(e));
    }
    // 执行闸（宪章 #01 / F-01 按宿主真实契约重写，参考 packages/core/tools prepareExecution）：
    //   waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' }))
    //   exec 携带 name/arguments/callId/agent；闸决策 = PreToolDecision：
    //     { kind: 'allow' } 放行 / { kind: 'deny', reason } 拒绝（宿主 materialize `Error: ${reason}`）
    // 放行时登记 callId → recordId，供 tools/post-execute 留痕（已放行 → 已执行闭环）。
    const allowedByCallId = new Map();
    try {
        if (typeof c.on === 'function') {
            // 本仓库的 cordis 泛型未声明本事件的多参形态——宽松挂接（运行时为 waterfall 多参）
            const onGate = c.on;
            // 闸策略（事故复盘 2026-09-05 根治）：只裁决**显式声明治理意图**的调用
            // （args.actionType 在场，如主动汇报类工具）。普通工作工具
            // （read/pwsh/grep/bash/memory/yuyi…）不声明治理意图 → 一律放行——
            // 主人日常会话全能力（决策六），分身基础能力不因治理层存在而受限。
            // 不可按工具名兜底裁决：DEFAULT_LEVELS 面向对外动作，未知名兜底 L2
            // 会把整套日常工作工具拦死（同日事故根因）。
            const gateDecide = (args) => typeof args.actionType === 'string' && args.actionType !== '' ? 'adjudicate' : 'pass';
            onGate('tools/pre-execute', async (exec, next) => {
                const e = exec;
                const args = (e?.arguments ?? {});
                if (gateDecide(args) === 'pass')
                    return await next();
                const actionType = String(args.actionType);
                const input = {
                    actionType,
                    targetScope: typeof args.targetScope === 'string' ? args.targetScope : actionType,
                };
                const actor = {};
                if (typeof args.registryId === 'string')
                    actor.registryId = args.registryId;
                if (typeof args.channel === 'string')
                    actor.channel = args.channel;
                if (actor.registryId !== undefined || actor.channel !== undefined)
                    input.actor = actor;
                if (typeof args.levelHint === 'string')
                    input.levelHint = args.levelHint;
                const result = check(input);
                if (result.judgment.decision !== '放行') {
                    return { kind: 'deny', reason: result.judgment.reason ?? ('账本裁决：' + result.judgment.decision) };
                }
                // 留痕登记：callId → recordId（post-execute 据此 markExecuted；容量封顶防泄漏）
                if (typeof e.callId === 'string' && e.callId !== '') {
                    allowedByCallId.set(e.callId, { id: result.record.id, at: Date.now() });
                    if (allowedByCallId.size > 500) {
                        const oldest = [...allowedByCallId.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                        if (oldest !== undefined)
                            allowedByCallId.delete(oldest[0]);
                    }
                }
                return { kind: 'allow' };
            });
            health.gateAttached = true;
            health.gateChannel = 'tools/pre-execute（waterfall exec/next → PreToolDecision；deny={kind,reason}）';
            health.gatePolicy = 'opt-in：仅裁决显式声明 actionType 的工具；未声明一律放行（决策六）';
            // 策略探针（宪章审计 C-③）：日常工具调用必须放行——闸绝不能瘫痪分身
            const probePass = gateDecide({ actionType: '主动汇报', targetScope: 'x' }) === 'adjudicate'
                && gateDecide({}) === 'pass'
                && gateDecide({ actionType: '' }) === 'pass';
            health.gatePolicyProbe = probePass ? 'ok' : 'failed';
            if (!probePass)
                health.issues.push('闸策略探针失败：未声明 actionType 的工具未放行');
            log(c.logger?.info, '[dsh-ledger] 执行闸已挂接 tools/pre-execute（opt-in 策略探针 ' + (probePass ? 'ok' : 'FAILED') + '）');
        }
        else {
            health.issues.push('宿主未提供事件面（ctx.on），执行闸未挂接——账本仅记录不拦截');
            log(c.logger?.warn, '[dsh-ledger] 宿主未提供事件面，执行闸未挂接');
        }
    }
    catch (e) {
        health.issues.push('执行闸挂接异常：' + (e instanceof Error ? e.message : String(e)));
        log(c.logger?.warn, '[dsh-ledger] 执行闸挂接异常:', e instanceof Error ? e.message : String(e));
    }
    // 执行后留痕：把「已放行 → 已执行」状态闭环（宪章第二阶段挂链）。
    // 只在工具成功时标记（isError 不留执行态）；无匹配记录时静默——
    // 并非每次工具调用都经过执行闸（未声明 actionType 的旁路调用）。
    try {
        if (typeof c.on === 'function') {
            // 该仓库的 cordis 泛型未声明本事件的 (exec, result, next) 三参形态——宽松挂接
            const onPost = c.on;
            onPost('tools/post-execute', async (exec, result, next) => {
                try {
                    const e2 = exec;
                    const key = typeof e2?.callId === 'string' ? e2.callId : '';
                    const hit = key !== '' ? allowedByCallId.get(key) : undefined;
                    if (hit !== undefined) {
                        allowedByCallId.delete(key);
                        // isError 亦留痕：错误同样是一次真实执行（审计不缺页）
                        const marked = markExecuted(hit.id);
                        if (!marked.ok)
                            log(c.logger?.warn, '[dsh-ledger] 执行留痕失败:', marked.error ?? '');
                    }
                }
                catch { /* 留痕失败不影响工具结果 */ }
                return await next();
            });
            health.gateChannel = 'tools/pre-execute + tools/post-execute';
            log(c.logger?.info, '[dsh-ledger] 执行留痕已挂接 tools/post-execute');
        }
    }
    catch (e) {
        health.issues.push('执行留痕挂接异常：' + (e instanceof Error ? e.message : String(e)));
        log(c.logger?.warn, '[dsh-ledger] 执行留痕挂接异常:', e instanceof Error ? e.message : String(e));
    }
    // 管理路由（可选）
    try {
        c.inject?.(['webServer'], (wctx) => {
            const web = wctx.get?.('webServer');
            if (web === undefined || typeof web.register !== 'function')
                return;
            const disposers = [];
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/stats',
                handler: (_req, res) => {
                    respondJson(res, 200, { ok: true, stats: stats(), health, pending: pendingApprovals() });
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/records',
                handler: (req, res) => {
                    const url = new URL(req.headers.host !== undefined ? `http://${String(req.headers.host)}${req.url ?? '/'}` : 'http://local/');
                    const filter = {};
                    const at = url.searchParams.get('actionType');
                    if (at !== null && at !== '')
                        filter.actionType = at;
                    const lim = url.searchParams.get('limit');
                    if (lim !== null && lim !== '' && Number.isFinite(Number(lim)))
                        filter.limit = Number(lim);
                    respondJson(res, 200, {
                        ok: true,
                        records: records(filter),
                        activeGrants: grants(true),
                    });
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/approvals',
                handler: (_req, res) => {
                    // 宪章 F-04：待批审批列表（今日待办渲染批准/驳回按钮的数据面）
                    respondJson(res, 200, { ok: true, approvals: pendingApprovals() });
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/approve',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = approve(String(body.approvalId ?? ''), { via: body.via === '命令' || body.via === 'web' ? body.via : '审批卡片' }, body.expiresInDays !== undefined ? { expiresInDays: body.expiresInDays } : {});
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/reject',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = rejectApproval(String(body.approvalId ?? ''), { via: body.via === '命令' || body.via === 'web' ? body.via : '审批卡片' });
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-ledger/result',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = body.feedbackOnly === true
                            ? feedback(String(body.recordId ?? ''), body.masterFeedback, body.summary)
                            : fillResult(String(body.recordId ?? ''), { summary: body.summary, masterFeedback: body.masterFeedback });
                        // v2 学习闭环：否决信号软依赖入队（dsh-twin 在位时；缺失静默跳过）
                        if (r.ok && body.masterFeedback === '推翻') {
                            try {
                                const twin = c.get?.('dsh-twin');
                                const rec = r.record;
                                twin?.enqueueLearning?.({
                                    kind: '否决',
                                    target: '策略卡',
                                    signal: `${rec?.actionType ?? '动作'}：${rec?.target?.scope ?? ''} 被主人推翻`,
                                    ref: rec?.id,
                                    by: '主人',
                                });
                            }
                            catch {
                                // 学习闭环缺席不阻断账本反馈
                            }
                        }
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            if (typeof web.effect === 'function') {
                web.effect(() => () => {
                    for (const d of disposers)
                        d();
                });
            }
            log(c.logger?.info, '[dsh-ledger] 管理路由已注册 (/dsh-ledger/*)');
        });
    }
    catch (e) {
        log(c.logger?.warn, '[dsh-ledger] webServer 注入失败（不影响核心服务）:', e instanceof Error ? e.message : String(e));
    }
}
export { approve, check, decideLevel, feedback, fillResult, grantCovers, grants, judge, loadLedger, markExecuted, normalizeCheckInput, pendingApprovals, records, rejectApproval, revoke, selfCheck, stats, } from "./ledger.js";
