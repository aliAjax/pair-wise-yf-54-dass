import { defineStore } from 'pinia';
import {
  activeSignatures,
  advanceBlockedReason,
  aspectState,
  buildReturnDiscrepancies,
  canAdvance,
  factHash,
  isUnderReview,
  isV2State,
  makeToken,
  migrateV1,
  pendingReconfirm,
  reconcileLines,
  SCHEMA_VERSION,
  STORAGE_KEY,
  ROLE_LABELS,
  ASPECT_LABELS,
  type Aspect,
  type CheckStatus,
  type Discrepancy,
  type Env,
  type Exhibit,
  type HandoverFacts,
  type InvalidReason,
  type PersistedState,
  type ReconcileLine,
  type Role,
  type Signature,
  type Stage
} from '../services/handover';

export type {
  Aspect,
  CheckStatus,
  Discrepancy,
  Env,
  Exhibit,
  HandoverFacts,
  PersistedState,
  ReconcileLine,
  Role,
  Signature,
  Stage
};
export { activeSignatures, aspectState, canAdvance, isUnderReview, pendingReconfirm, reconcileLines };

export interface SignResult {
  ok: boolean;
  reason?: string;
}

function nowTs(): number {
  return Date.now();
}

const SEED_AT = new Date('2026-09-01T09:00:00').getTime();

function makeSeed(): PersistedState {
  const stages: Stage[] = [
    ...Array.from({ length: 8 }, () => 'arrival' as Stage),
    ...Array.from({ length: 10 }, () => 'install' as Stage),
    ...Array.from({ length: 6 }, () => 'return' as Stage)
  ];
  const names = ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'];

  const exhibits: Exhibit[] = stages.map((stage, index) => {
    const facts: HandoverFacts = {
      sealCode: `SEAL-M${String(index + 1).padStart(3, '0')}`,
      packageStatus: '木箱完好',
      attachments: ['交接单', '附件清单', '现状照片'],
      env: { temperature: 20 + (index % 3), humidity: 48 + (index % 8), light: 120 + index * 3 },
      hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区'
    };
    const exhibit: Exhibit = {
      id: `ex-${index + 1}`,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: names[index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: facts.hall,
      stage,
      status: 'pending',
      facts,
      signatures: [],
      discrepancies: [],
      arrivalSnapshot: null,
      returnRegistration: null,
      reconciledAt: null
    };

    if (stage !== 'arrival') {
      // 已进入布展/归还的展品：到场点交三项齐全。
      exhibit.arrivalSnapshot = makeToken(facts).facts;
      exhibit.signatures.push(
        ...(['keeper', 'installer', 'lender'] as Role[]).map((role, roleIndex) => ({
          id: `sig-ex-${index + 1}-arr-${role}`,
          role,
          aspect: { keeper: 'seal', installer: 'environment', lender: 'disposition' }[
            role
          ] as Aspect,
          stage: 'arrival' as Stage,
          actor: role,
          signedAt: SEED_AT - 3600_000 - roleIndex * 60_000,
          token: makeToken(facts)
        }))
      );
    }
    if (stage === 'install') {
      exhibit.signatures.push(
        ...(['keeper', 'installer', 'lender'] as Role[]).map((role, roleIndex) => ({
          id: `sig-ex-${index + 1}-inst-${role}`,
          role,
          aspect: { keeper: 'seal', installer: 'environment', lender: 'disposition' }[
            role
          ] as Aspect,
          stage: 'install' as Stage,
          actor: role,
          signedAt: SEED_AT - 1800_000 - roleIndex * 60_000,
          token: makeToken(facts)
        }))
      );
    }
    if (stage === 'return') {
      // 归还登记与到场快照一致，对账无差异。
      exhibit.returnRegistration = makeToken(facts).facts;
      exhibit.reconciledAt = SEED_AT;
    }
    exhibit.status = stage === 'arrival' ? 'pending' : 'passed';
    return exhibit;
  });

  // ex-5：重大差异（封条编号不一致），借展方已给处理意见。
  const ex5 = exhibits[4];
  const d1: Discrepancy = {
    id: 'd1',
    exhibitId: 'ex-5',
    stage: 'arrival',
    field: 'sealCode',
    expected: ex5.facts.sealCode,
    actual: 'SEAL-M999',
    title: '封条编号与交接单不一致',
    severity: 'major',
    opinion: '以到场实际封条 SEAL-M999 为准，借展方与保管员共同拍照备案后继续布展。',
    resolved: false,
    createdAt: SEED_AT - 7200_000
  };
  ex5.discrepancies.push(d1);
  ex5.status = 'issue';

  // ex-7：轻微差异（木箱磕碰）。
  const ex7 = exhibits[6];
  ex7.discrepancies.push({
    id: 'd2',
    exhibitId: 'ex-7',
    stage: 'arrival',
    field: 'packageStatus',
    expected: '木箱完好',
    actual: '木箱边角轻微磕碰',
    title: '木箱边角轻微磕碰',
    severity: 'minor',
    opinion: '磕碰仅限外包装，开箱后展品本体无损，借展方同意继续核验。',
    resolved: true,
    createdAt: SEED_AT - 9000_000
  });

  return { schemaVersion: SCHEMA_VERSION, exhibits, queued: 0 };
}


function loadState(): PersistedState {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return makeSeed();
  try {
    const parsed = JSON.parse(saved) as PersistedState | ReturnType<typeof JSON.parse>;
    if (isV2State(parsed)) return parsed;
    // 旧版本（v1：signed 角色名数组 + 扁平 discrepancies）升级读回。
    return migrateV1(parsed as Parameters<typeof migrateV1>[0]);
  } catch {
    return makeSeed();
  }
}

interface State {
  schemaVersion: number;
  exhibits: Exhibit[];
  queued: number;
  lastError: string;
  lastWarning: string;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => {
    const initial = loadState();
    return {
      schemaVersion: initial.schemaVersion,
      exhibits: initial.exhibits,
      queued: initial.queued,
      lastError: '',
      lastWarning: ''
    };
  },
  getters: {
    unresolved(state): number {
      return state.exhibits.reduce(
        (sum, exhibit) => sum + exhibit.discrepancies.filter((item) => !item.resolved).length,
        0
      );
    },
    reviewCount(state): number {
      return state.exhibits.filter((exhibit) => exhibit.status === 'review').length;
    },
    stageCounts(state) {
      return {
        arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
        install: state.exhibits.filter((item) => item.stage === 'install').length,
        return: state.exhibits.filter((item) => item.stage === 'return').length
      };
    },
    byId(state): (id: string) => Exhibit | undefined {
      return (id: string) => state.exhibits.find((item) => item.id === id);
    }
  },
  actions: {
    persist() {
      const data: PersistedState = {
        schemaVersion: SCHEMA_VERSION,
        exhibits: this.exhibits,
        queued: this.queued
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
    markQueued() {
      this.queued += 1;
      this.persist();
    },
    syncQueue() {
      this.queued = 0;
      this.persist();
    },
    clearNotice() {
      this.lastError = '';
      this.lastWarning = '';
    },

    // ---------- 分头核验：三类事实由不同角色更新 ----------

    /** 保管员更新包装封条（封条号、包装、附件）。 */
    updateSeal(
      id: string,
      actorRole: Role,
      patch: { sealCode?: string; packageStatus?: string; attachments?: string[] }
    ): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (actorRole !== 'keeper') {
        this.lastError = `越权拒绝：只有保管员能确认包装封条，${ROLE_LABELS[actorRole]}不能代为操作。`;
        return { ok: false, reason: this.lastError };
      }
      // 已签字确认的封条/包装/附件不能直接覆盖；发现出入须登记差异项。
      if (aspectState(exhibit, 'seal', exhibit.stage).current) {
        const fields: string[] = [];
        if (patch.sealCode !== undefined && patch.sealCode !== exhibit.facts.sealCode) {
          fields.push('封条编号');
        }
        if (
          patch.packageStatus !== undefined &&
          patch.packageStatus !== exhibit.facts.packageStatus
        ) {
          fields.push('包装状态');
        }
        if (
          patch.attachments !== undefined &&
          JSON.stringify(patch.attachments) !== JSON.stringify(exhibit.facts.attachments)
        ) {
          fields.push('附件清单');
        }
        if (fields.length) {
          this.lastError = `本阶段包装封条已签字确认，${fields.join('、')}的出入请登记差异项，不能直接修改。`;
          return { ok: false, reason: this.lastError };
        }
        return { ok: true };
      }
      Object.assign(exhibit.facts, {
        sealCode: patch.sealCode ?? exhibit.facts.sealCode,
        packageStatus: patch.packageStatus ?? exhibit.facts.packageStatus,
        attachments: patch.attachments ?? exhibit.facts.attachments
      });
      this.markQueued();
      return { ok: true };
    },

    /** 布展负责人更新环境条件；更新会让旧的环境相关签字快照失效。 */
    updateEnvironment(id: string, actorRole: Role, env: Partial<Env>): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (actorRole !== 'installer') {
        this.lastError = '越权拒绝：只有布展负责人能确认环境条件。';
        return { ok: false, reason: this.lastError };
      }
      const before = JSON.stringify(exhibit.facts.env);
      exhibit.facts.env = { ...exhibit.facts.env, ...env };
      if (JSON.stringify(exhibit.facts.env) !== before) {
        this.invalidateSnapshots(exhibit, 'env');
      }
      this.persist();
      return { ok: true };
    },

    /** 更新展品位置（展厅/柜位）；更新会让旧签字快照失效，展品退回待复核。 */
    updateLocation(id: string, hall: string, actorRole?: Role): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (actorRole && actorRole === 'lender') {
        this.lastError = '越权拒绝：借展方不能变更展品位置。';
        return { ok: false, reason: this.lastError };
      }
      if (exhibit.facts.hall.trim() === hall.trim()) return { ok: true };
      exhibit.facts.hall = hall;
      exhibit.hall = hall;
      this.invalidateSnapshots(exhibit, 'location');
      this.persist();
      return { ok: true };
    },

    invalidateSnapshots(exhibit: Exhibit, reason: InvalidReason) {
      const currentHash = factHash(exhibit.facts);
      let changed = false;
      exhibit.signatures.forEach((signature) => {
        // 只失效当前核验阶段的签字；历史阶段（如到场点交）的记录与其冻结快照保持有效。
        if (
          signature.stage === exhibit.stage &&
          !signature.invalidated &&
          signature.token.hash !== currentHash
        ) {
          signature.invalidated = { reason, at: nowTs() };
          changed = true;
        }
      });
      if (changed) {
        // 快照失效：展品退回待复核，原角色再确认才能继续。
        exhibit.status = 'review';
        const aspects = pendingReconfirm(exhibit, exhibit.stage)
          .map((aspect) => ASPECT_LABELS[aspect])
          .join('、');
        this.lastWarning =
          reason === 'env'
            ? `环境条件已更新，原签字快照失效，展品退回待复核，需原角色重新确认${aspects ? `（${aspects}）` : ''}后才能继续。`
            : `展品位置已更新，原签字快照失效，展品退回待复核，需原角色重新确认${aspects ? `（${aspects}）` : ''}后才能继续。`;
      }
    },

    /**
     * 分头核验、各签各的：角色只能签自己职责内的核验项，
     * 越权代签（替别人签字）一律拒绝。
     */
    sign(id: string, role: Role, actor: string): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      const aspect = (
        { keeper: 'seal', installer: 'environment', lender: 'disposition' } as const
      )[role];
      const state = aspectState(exhibit, aspect, exhibit.stage);
      if (state.current) {
        this.lastError = `本阶段${{ keeper: '包装封条', installer: '环境条件', lender: '差异处理意见' }[role]}已有有效签字，无需重复签署。`;
        return { ok: false, reason: this.lastError };
      }
      const signature: Signature = {
        id: `sig-${id}-${exhibit.stage}-${aspect}-${nowTs()}`,
        role,
        aspect,
        stage: exhibit.stage,
        actor: actor.trim() || role,
        signedAt: nowTs(),
        token: makeToken(exhibit.facts)
      };
      exhibit.signatures.push(signature);
      // 待复核只在仍有失效旧签且未补签时成立；原角色补签后即解除。
      if (exhibit.status === 'review' && !isUnderReview(exhibit)) {
        exhibit.status = 'pending';
      }
      this.markQueued();
      return { ok: true };
    },

    addDiscrepancy(
      id: string,
      payload: Pick<Discrepancy, 'field' | 'expected' | 'actual' | 'title' | 'severity'> & {
        opinion: string;
      },
      actorRole: Role
    ): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (actorRole !== 'lender') {
        this.lastError = '越权拒绝：差异处理意见只能由借展方确认。';
        return { ok: false, reason: this.lastError };
      }
      exhibit.discrepancies.push({
        id: `d-${id}-${nowTs()}`,
        exhibitId: id,
        stage: exhibit.stage,
        field: payload.field,
        expected: payload.expected,
        actual: payload.actual,
        title: payload.title,
        severity: payload.severity,
        opinion: payload.opinion,
        resolved: false,
        createdAt: nowTs()
      });
      exhibit.status = 'issue';
      this.markQueued();
      return { ok: true };
    },

    /** 借展方补充/修改差异处理意见。 */
    updateDiscrepancyOpinion(discrepancyId: string, opinion: string, actorRole: Role): SignResult {
      if (actorRole !== 'lender') {
        this.lastError = '越权拒绝：差异处理意见只能由借展方填写。';
        return { ok: false, reason: this.lastError };
      }
      const found = this.exhibits
        .flatMap((exhibit) => exhibit.discrepancies)
        .find((item) => item.id === discrepancyId);
      if (!found) return { ok: false, reason: '未找到差异项。' };
      found.opinion = opinion;
      this.markQueued();
      return { ok: true };
    },

    resolveDiscrepancy(discrepancyId: string, actorRole: Role): SignResult {
      const exhibit = this.exhibits.find((item) =>
        item.discrepancies.some((entry) => entry.id === discrepancyId)
      );
      const found = exhibit?.discrepancies.find((item) => item.id === discrepancyId);
      if (!exhibit || !found) return { ok: false, reason: '未找到差异项。' };
      // 差异处理意见是借展方的职责：没有处理意见不能解决。
      if (!found.opinion.trim()) {
        this.lastError = '借展方尚未给出差异处理意见，不能解决该差异。';
        return { ok: false, reason: this.lastError };
      }
      if (actorRole !== 'lender') {
        this.lastError = '越权拒绝：差异处理意见只能由借展方确认解决。';
        return { ok: false, reason: this.lastError };
      }
      found.resolved = true;
      if (!exhibit.discrepancies.some((item) => !item.resolved)) exhibit.status = 'pending';
      this.markQueued();
      return { ok: true };
    },

    // ---------- 阶段推进 ----------

    advance(id: string): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (!canAdvance(exhibit)) {
        this.lastError = advanceBlockedReason(exhibit) || '当前不满足推进条件。';
        return { ok: false, reason: this.lastError };
      }
      if (exhibit.stage === 'arrival') {
        // 冻结到场点交快照，作为闭展对账基准。
        exhibit.arrivalSnapshot = makeToken(exhibit.facts).facts;
        exhibit.stage = 'install';
      } else if (exhibit.stage === 'install') {
        exhibit.stage = 'return';
        exhibit.returnRegistration = null;
        exhibit.reconciledAt = null;
      }
      this.markQueued();
      return { ok: true };
    },

    // ---------- 闭展归还：归还登记 + 到场快照逐项对账 ----------

    registerReturn(id: string, registration: HandoverFacts): SignResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, reason: '未找到展品。' };
      if (!exhibit.arrivalSnapshot) {
        this.lastError = '缺少到场点交快照，无法对账。';
        return { ok: false, reason: this.lastError };
      }
      exhibit.returnRegistration = makeToken(registration).facts;
      exhibit.facts = JSON.parse(JSON.stringify(registration)) as HandoverFacts;
      exhibit.hall = registration.hall;
      this.markQueued();
      return { ok: true };
    },

    /**
     * 闭展对账：归还登记与到场点交快照逐项比对，
     * 差异落到差异项，并保留原处理意见（沿用同项历史意见）。
     */
    reconcileReturn(id: string): SignResult & { lines?: ReconcileLine[]; added?: number } {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.arrivalSnapshot || !exhibit.returnRegistration) {
        this.lastError = '归还登记或到场点交快照缺失，无法对账。';
        return { ok: false, reason: this.lastError };
      }
      const lines = reconcileLines(exhibit.arrivalSnapshot, exhibit.returnRegistration);
      // 上一次对账生成的归还差异可能已被借展方补充过意见：先留存再重建。
      const priorReturnOpinions = new Map<string, string>();
      exhibit.discrepancies.forEach((item) => {
        if (item.stage === 'return' && item.id.includes('-ret-') && item.opinion.trim()) {
          priorReturnOpinions.set(item.field, item.opinion);
        }
      });
      // 清掉上一次自动对账生成的归还差异，避免重复；手工录入差异保留。
      exhibit.discrepancies = exhibit.discrepancies.filter(
        (item) => !(item.stage === 'return' && item.id.includes(`-ret-`))
      );
      const created = buildReturnDiscrepancies(exhibit, nowTs());
      created.forEach((item) => {
        // 优先保留借展方在归还阶段已给出的意见，否则沿用历史同项原处理意见。
        const kept = priorReturnOpinions.get(item.field);
        if (kept) item.opinion = kept;
        exhibit.discrepancies.push(item);
      });
      exhibit.reconciledAt = nowTs();
      exhibit.status = created.length ? 'issue' : 'passed';
      this.markQueued();
      return { ok: true, lines, added: created.length };
    },

    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      const facts: HandoverFacts = {
        sealCode: '',
        packageStatus: '',
        attachments: [],
        env: { temperature: 20, humidity: 50, light: 150 },
        hall: payload.hall
      };
      this.exhibits.unshift({
        id: `ex-${nowTs()}`,
        code: payload.code,
        name: payload.name,
        lender: payload.lender,
        hall: payload.hall,
        stage: 'arrival',
        status: 'pending',
        facts,
        signatures: [],
        discrepancies: [],
        arrivalSnapshot: null,
        returnRegistration: null,
        reconciledAt: null
      });
      this.markQueued();
    }
  }
});
