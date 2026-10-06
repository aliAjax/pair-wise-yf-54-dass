import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue' | 'recheck';

/** 核验角色：保管员、布展负责人、借展方 */
export type Role = 'custodian' | 'installer' | 'borrower';
/** 签字项：包装封条、环境条件、差异处理意见 */
export type SignKind = 'seal' | 'environment' | 'opinion';

export interface Signature {
  role: Role;
  kind: SignKind;
  at: number;
  /** 借展方签署差异处理意见时填写的处理意见 */
  opinion?: string;
  /** 环境或位置更新后旧快照失效，标记为待复核 */
  stale?: boolean;
}

export interface Environment {
  temperature: number;
  humidity: number;
  light: number;
}

/** 到场点交快照：点交完成时固化的封条、环境与位置状态 */
export interface Snapshot {
  environment: Environment;
  hall: string;
  sealIntact: boolean;
  at: number;
}

/** 闭展归还登记：归还时逐项登记的实际状态 */
export interface ReturnRecord {
  environment: Environment;
  hall: string;
  sealIntact: boolean;
  at: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: Signature[];
  environment: Environment;
  /** 到场点交快照，推进到布展阶段时固化 */
  arrivalSnapshot?: Snapshot;
  /** 闭展归还登记 */
  returnRecord?: ReturnRecord;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
  /** 差异处理意见（借展方签署） */
  opinion?: string;
  /** 差异来源：到场点交或闭展归还 */
  origin?: 'arrival' | 'return';
  /** 归还差异关联的原始差异，用于保留原处理意见 */
  refId?: string;
}

interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  /** 数据版本，用于升级后读回旧数据 */
  version: number;
}

const STORAGE_KEY = 'yf54-exhibition-state';
const CURRENT_VERSION = 2;

/** 每个角色只能签署自己职责范围内的核验项，越权代签一律拒绝 */
export const ROLE_SCOPE: Record<Role, SignKind> = {
  custodian: 'seal',
  installer: 'environment',
  borrower: 'opinion'
};

export const ROLE_LABEL: Record<Role, string> = {
  custodian: '保管员',
  installer: '布展负责人',
  borrower: '借展方'
};

export const KIND_LABEL: Record<SignKind, string> = {
  seal: '包装封条',
  environment: '环境条件',
  opinion: '差异处理意见'
};

function makeSeed(): State {
  return {
    version: CURRENT_VERSION,
    exhibits: Array.from({ length: 24 }, (_, index) => ({
      id: `ex-${index + 1}`,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
      stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
      status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
      signed: [],
      environment: { temperature: 20 + (index % 3), humidity: 48 + (index % 8), light: 120 + index * 3 }
    })),
    discrepancies: [
      { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false, origin: 'arrival', opinion: '重新核对封条编号并补签说明' },
      { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false, origin: 'arrival', opinion: '拍照留档，归还时复检' }
    ],
    queued: 0
  };
}

/** 将任意历史状态升级为当前版本，保证已有数据升级后仍能读回 */
function migrate(raw: unknown): State {
  if (!raw || typeof raw !== 'object') return makeSeed();
  const data = raw as Record<string, unknown>;
  const exhibits = Array.isArray(data.exhibits) ? (data.exhibits as Record<string, unknown>[]) : [];
  const discrepancies = Array.isArray(data.discrepancies) ? (data.discrepancies as Record<string, unknown>[]) : [];

  const migratedExhibits: Exhibit[] = exhibits.map((item) => {
    const signed = Array.isArray(item.signed) ? item.signed : [];
    // v1 中 signed 是角色字符串数组，统一升级为 Signature 结构
    const signatures: Signature[] = signed
      .map((entry) => {
        if (typeof entry === 'string') {
          const role = entry as Role;
          const kind = ROLE_SCOPE[role];
          if (!kind) return null;
          return { role, kind, at: Number(item.updatedAt ?? 0) || 0 };
        }
        if (entry && typeof entry === 'object') {
          const sig = entry as Record<string, unknown>;
          const role = sig.role as Role;
          const kind = (sig.kind as SignKind) ?? ROLE_SCOPE[role];
          if (!role || !kind) return null;
          return {
            role,
            kind,
            at: typeof sig.at === 'number' ? sig.at : 0,
            opinion: typeof sig.opinion === 'string' ? sig.opinion : undefined,
            stale: Boolean(sig.stale)
          } as Signature;
        }
        return null;
      })
      .filter((sig): sig is Signature => sig !== null);

    const environment = (item.environment ?? {}) as Partial<Environment>;
    return {
      id: String(item.id ?? ''),
      code: String(item.code ?? ''),
      name: String(item.name ?? ''),
      lender: String(item.lender ?? ''),
      hall: String(item.hall ?? ''),
      stage: (item.stage as Stage) ?? 'arrival',
      status: (item.status as CheckStatus) ?? 'pending',
      signed: signatures,
      environment: {
        temperature: typeof environment.temperature === 'number' ? environment.temperature : 20,
        humidity: typeof environment.humidity === 'number' ? environment.humidity : 50,
        light: typeof environment.light === 'number' ? environment.light : 150
      },
      arrivalSnapshot: item.arrivalSnapshot as Snapshot | undefined,
      returnRecord: item.returnRecord as ReturnRecord | undefined
    };
  });

  const migratedDiscrepancies: Discrepancy[] = discrepancies.map((item) => ({
    id: String(item.id ?? ''),
    exhibitId: String(item.exhibitId ?? ''),
    title: String(item.title ?? ''),
    severity: (item.severity as 'minor' | 'major') ?? 'minor',
    resolved: Boolean(item.resolved),
    opinion: typeof item.opinion === 'string' ? item.opinion : undefined,
    origin: (item.origin as 'arrival' | 'return') ?? 'arrival',
    refId: typeof item.refId === 'string' ? item.refId : undefined
  }));

  return {
    version: CURRENT_VERSION,
    exhibits: migratedExhibits,
    discrepancies: migratedDiscrepancies,
    queued: typeof data.queued === 'number' ? data.queued : 0
  };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return makeSeed();
  try {
    return migrate(JSON.parse(saved));
  } catch {
    return makeSeed();
  }
}

/** 环境条件是否超出允许范围（温度 18-24℃，湿度 45-65%，照度 ≤ 300 lux） */
export function environmentOk(env: Environment): boolean {
  return env.temperature >= 18 && env.temperature <= 24 && env.humidity >= 45 && env.humidity <= 65 && env.light <= 300;
}

/** 归还登记与到场点交快照逐项对账，返回差异描述 */
export function reconcile(snapshot: Snapshot, record: ReturnRecord): string[] {
  const diffs: string[] = [];
  if (snapshot.sealIntact !== record.sealIntact) diffs.push('封条状态与到场点交快照不一致');
  if (snapshot.hall !== record.hall) diffs.push(`展位由 ${snapshot.hall} 变更为 ${record.hall}`);
  const envDiff = (label: string, from: number, to: number, unit: string) => {
    if (from !== to) diffs.push(`${label}由 ${from}${unit} 变为 ${to}${unit}`);
  };
  envDiff('温度', snapshot.environment.temperature, record.environment.temperature, '℃');
  envDiff('湿度', snapshot.environment.humidity, record.environment.humidity, '%');
  envDiff('照度', snapshot.environment.light, record.environment.light, ' lux');
  return diffs;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    /** 存在失效签字、待原角色复核的展品 */
    pendingRecheck: (state) => state.exhibits.filter((item) => item.signed.some((sig) => sig.stale)).length
  },
  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.$state, version: CURRENT_VERSION }));
    },
    markQueued() {
      this.queued += 1;
      this.persist();
    },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (exhibit) {
        exhibit.status = status;
        this.markQueued();
      }
    },
    /**
     * 分头核验签字。保管员只能签包装封条，布展负责人只能签环境条件，
     * 借展方签差异处理意见；越权代签一律拒绝。
     */
    sign(id: string, role: Role, kind: SignKind, opinion?: string): { ok: boolean; reason?: string } {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '展品不存在' };
      if (ROLE_SCOPE[role] !== kind) {
        return { ok: false, reason: `${ROLE_LABEL[role]}只能确认${KIND_LABEL[ROLE_SCOPE[role]]}，不能代签${KIND_LABEL[kind]}` };
      }
      const existing = exhibit.signed.find((sig) => sig.role === role && sig.kind === kind);
      if (existing && !existing.stale) return { ok: true };
      if (existing && existing.stale) {
        // 原角色复核后恢复有效，重新固化当前快照
        existing.stale = false;
        existing.at = Date.now();
        if (kind === 'opinion') existing.opinion = opinion ?? existing.opinion;
      } else {
        exhibit.signed.push({ role, kind, at: Date.now(), opinion: kind === 'opinion' ? opinion : undefined });
      }
      if (exhibit.status === 'recheck' && !exhibit.signed.some((sig) => sig.stale)) {
        exhibit.status = environmentOk(exhibit.environment) ? 'passed' : 'issue';
      }
      this.markQueued();
      return { ok: true };
    },
    /** 环境条件更新：旧签字快照失效，展品退回待复核，由原角色再确认 */
    updateEnvironment(id: string, environment: Environment) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      exhibit.environment = environment;
      this.invalidateSignatures(exhibit);
      exhibit.status = environmentOk(environment) ? 'recheck' : 'issue';
      this.markQueued();
    },
    /** 展品位置更新：旧签字快照失效，退回待复核 */
    updateHall(id: string, hall: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      exhibit.hall = hall;
      this.invalidateSignatures(exhibit);
      exhibit.status = 'recheck';
      this.markQueued();
    },
    /** 环境或位置变化后，所有签字快照失效，等待原角色复核 */
    invalidateSignatures(exhibit: Exhibit) {
      for (const sig of exhibit.signed) sig.stale = true;
    },
    /** 原角色对失效签字进行复核确认 */
    reconfirm(id: string, role: Role, opinion?: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const target = exhibit.signed.find((sig) => sig.role === role && sig.stale);
      if (!target) return;
      target.stale = false;
      target.at = Date.now();
      if (target.kind === 'opinion') target.opinion = opinion ?? target.opinion;
      if (!exhibit.signed.some((sig) => sig.stale)) {
        exhibit.status = environmentOk(exhibit.environment) ? 'passed' : 'issue';
      }
      this.markQueued();
    },
    /** 推进到下一阶段：签字齐全且无失效、无未解决差异方可推进 */
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const requiredKinds: SignKind[] = ['seal', 'environment', 'opinion'];
      const signedKinds = new Set(exhibit.signed.filter((sig) => !sig.stale).map((sig) => sig.kind));
      const missing = requiredKinds.filter((kind) => !signedKinds.has(kind));
      if (missing.length > 0) return;
      if (this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      if (exhibit.signed.some((sig) => sig.stale)) return;
      if (exhibit.stage === 'arrival') {
        // 到场点交完成，固化点交快照
        exhibit.arrivalSnapshot = {
          environment: { ...exhibit.environment },
          hall: exhibit.hall,
          sealIntact: true,
          at: Date.now()
        };
        exhibit.stage = 'install';
      } else if (exhibit.stage === 'install') {
        exhibit.stage = 'return';
      }
      this.markQueued();
    },
    /**
     * 闭展归还登记：以归还登记与到场点交快照逐项对账，
     * 差异落到差异项并保留原处理意见。
     */
    registerReturn(id: string, record: Omit<ReturnRecord, 'at'>) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.arrivalSnapshot) return;
      exhibit.returnRecord = { ...record, at: Date.now() };
      const diffs = reconcile(exhibit.arrivalSnapshot, exhibit.returnRecord);
      for (const title of diffs) {
        // 关联该展品原始的到场差异，保留原处理意见
        const original = this.discrepancies.find(
          (item) => item.exhibitId === id && item.origin === 'arrival' && item.title === title
        );
        this.discrepancies.push({
          id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          exhibitId: id,
          title,
          severity: title.includes('封条') ? 'major' : 'minor',
          resolved: false,
          origin: 'return',
          opinion: original?.opinion,
          refId: original?.id
        });
      }
      this.markQueued();
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id);
      if (item) {
        item.resolved = true;
        this.markQueued();
      }
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({
        id: `ex-${Date.now()}`,
        ...payload,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: { temperature: 20, humidity: 50, light: 150 }
      });
      this.markQueued();
    },
    syncQueue() {
      this.queued = 0;
      this.persist();
    }
  }
});
