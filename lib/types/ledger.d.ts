export type Level = 'L0' | 'L1' | 'L2' | 'L3';
export declare const LEVELS: readonly Level[];
/** 默认委托级别表：动作类型 → 级别（策略卡 levelHint 可覆盖，但未知类型恒为 L2） */
export declare const DEFAULT_LEVELS: Record<string, Level>;
/** 未知动作类型的兜底级别：fail-closed（没见过的动作需要批准） */
export declare const UNKNOWN_ACTION_LEVEL: Level;
/** 裁决动作类型级别；策略卡显式 levelHint 优先，未知动作类型兜底 L2 且不允许降级到 L2 以下 */
export declare function decideLevel(actionType: unknown, levelHint?: unknown): Level;
/** 授权记录（只能由批准通道创建；by = 通道签名而非模型声明） */
export interface Grant {
    id: string;
    actionType: string;
    targetScope: string;
    by: string;
    via: '审批卡片' | '命令' | 'web';
    createdAt: string;
    expiresAt?: string;
    revokedAt?: string;
    revokeReason?: string;
    /** 幂等键：同一批准事件重放不产生第二条授权 */
    idempotencyKey: string;
    /** 来源被阻断记录（一键批准场景） */
    fromRecordId?: string;
}
export type RecordStatus = '已放行' | '已阻断' | '已拒绝' | '已执行' | '已回填';
export type MasterFeedback = '认可' | '推翻' | '未评价';
export interface StatusEntry {
    status: RecordStatus;
    at: string;
    via: string;
}
export interface LedgerRecord {
    id: string;
    actionType: string;
    level: Level;
    actor?: {
        registryId?: string;
        channel?: string;
    };
    target: {
        scope: string;
        digest?: string;
    };
    status: RecordStatus;
    /** 状态迁移历史（追加式审计） */
    history: StatusEntry[];
    authorization?: {
        grantId: string;
        via: string;
        by: string;
    };
    outcome?: {
        at: string;
        summary: string;
        masterFeedback: MasterFeedback;
    };
    createdAt: string;
}
export interface Approval {
    id: string;
    recordId: string;
    actionType: string;
    targetScope: string;
    state: '待批准' | '已批准' | '已拒绝' | '已过期';
    createdAt: string;
    expiresAt: string;
    resolvedAt?: string;
    by?: string;
    via?: string;
}
export interface LedgerStore {
    records: LedgerRecord[];
    grants: Grant[];
    approvals: Approval[];
}
export declare function ledgerHome(): string;
export declare function loadLedger(): LedgerStore;
export declare function saveLedger(store: LedgerStore): void;
export declare function setNowForTest(fn: () => Date): void;
/** 授权是否覆盖（动作类型 + 范围）：scope='*' 通配；否则要求记录范围包含授权范围 */
export declare function grantCovers(grant: Grant, actionType: string, targetScope: string): boolean;
export type Decision = '放行' | '阻断' | '拒绝';
export interface Judgment {
    decision: Decision;
    level: Level;
    grant?: Grant;
    reason: string;
}
/** 纯裁决：给定级别与当前有效授权，判定放行/阻断/拒绝（无 IO，契约测试锁定） */
export declare function judge(level: Level, grants: Grant[], actionType: string, targetScope: string): Judgment;
export interface CheckInput {
    actionType: unknown;
    actor?: {
        registryId?: unknown;
        channel?: unknown;
    };
    targetScope: unknown;
    digest?: unknown;
    levelHint?: unknown;
}
export interface NormalizedCheck {
    actionType: string;
    targetScope: string;
    level: Level;
    actor?: {
        registryId?: string;
        channel?: string;
    };
    digest?: string;
}
export declare function normalizeCheckInput(input: CheckInput): NormalizedCheck;
export interface CheckResult {
    record: LedgerRecord;
    judgment: Judgment;
    /** 阻断时生成的待批准令牌（转人工用，3 分钟 TTL） */
    approval?: Approval;
}
/** 提交一次外发动作裁决（持久化记录 + 生成审批令牌） */
export declare function check(input: CheckInput, opts?: {
    via?: string;
}): CheckResult;
export interface ResolveResult {
    ok: boolean;
    record?: LedgerRecord;
    grant?: Grant;
    error?: string;
}
/**
 * 批准：审批令牌 → 授权记录（机械落账，作者签名 = 通道）+ 记录放行。
 * 幂等：同一 approvalId 重复批准返回同一授权，不产生双记录。
 */
export declare function approve(approvalId: string, by?: {
    by?: string;
    via?: '审批卡片' | '命令' | 'web';
}, opts?: {
    expiresInDays?: number;
}): ResolveResult;
/** 拒绝：记录终态「已拒绝」，不产生任何授权 */
export declare function rejectApproval(approvalId: string, by?: {
    by?: string;
    via?: '审批卡片' | '命令' | 'web';
}): ResolveResult;
/** 标记已执行（post-execute 钩）：工具真的跑完了 */
export declare function markExecuted(recordId: string): ResolveResult;
export declare function markExecutedForAction(actionType: string, targetScope?: string): ResolveResult;
export interface OutcomeInput {
    summary: unknown;
    masterFeedback?: unknown;
    evidenceRef?: unknown;
}
/** 结果回填（决策二性质 4）：每次放行的动作执行后强制记录实际结果与主人反馈 */
export declare function fillResult(recordId: string, input: OutcomeInput): ResolveResult;
/** 主人反馈更新（认可/推翻）：推翻记录自动成为策略卡修订的候选证据 */
export declare function feedback(recordId: string, masterFeedback: unknown, note?: unknown): ResolveResult;
export declare function revoke(grantId: string, reason: string): ResolveResult;
export interface RecordFilter {
    actorId?: string;
    actionType?: string;
    status?: RecordStatus;
    limit?: number;
}
export declare function records(filter?: RecordFilter): LedgerRecord[];
export declare function grants(onlyActive?: boolean): Grant[];
export declare function pendingApprovals(): Approval[];
export interface LedgerStats {
    total: number;
    byStatus: Record<RecordStatus, number>;
    rejectedRate: number | null;
    activeGrants: number;
    pendingApprovals: number;
}
/** 统计：事后否决率 = 推翻 / (认可 + 推翻)，仅对已回填且有主人反馈的记录计算 */
export declare function stats(): LedgerStats;
/**
 * 启动自检（fail-closed 翻转：拦截器必须在位且裁决正确）。
 * 纯层自检：不触碰真实账本文件，验证裁决不变量。
 */
export declare function selfCheck(): {
    ok: boolean;
    issues: string[];
};
