export declare const name = "dsh-ledger";
export declare const provide: string[];
export declare function apply(ctx: unknown): void;
export { approve, check, decideLevel, feedback, fillResult, grantCovers, grants, judge, loadLedger, markExecuted, normalizeCheckInput, pendingApprovals, records, rejectApproval, revoke, selfCheck, stats, } from './ledger.ts';
export type { Approval, Decision, Grant, Judgment, LedgerRecord, Level, RecordStatus } from './ledger.ts';
