// 点交领域规则：角色权限、签字快照、失效重签、闭展对账与旧数据迁移。
// 纯函数模块，不依赖 Vue/Pinia，便于单测与升级校验。

export type Role = 'keeper' | 'installer' | 'lender';
export type Aspect = 'seal' | 'environment' | 'disposition';
export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue' | 'review';

export const ROLE_LABELS: Record<Role, string> = {
  keeper: '保管员',
  installer: '布展负责人',
  lender: '借展方'
};

export const ASPECT_LABELS: Record<Aspect, string> = {
  seal: '包装封条',
  environment: '环境条件',
  disposition: '差异处理意见'
};

export const STAGE_LABELS: Record<Stage, string> = {
  arrival: '到场点交',
  install: '布展核验',
  return: '闭展归还'
};

/** 每个角色只能确认自己职责内的核验项；越权（替别人签字）一律拒绝。 */
export const ROLE_SCOPE: Record<Role, Aspect> = {
  keeper: 'seal',
  installer: 'environment',
  lender: 'disposition'
};

export interface Env {
  temperature: number;
  humidity: number;
  light: number;
}

/** 签字时冻结的事实快照：封条、包装、附件、环境、位置。 */
export interface HandoverFacts {
  sealCode: string;
  packageStatus: string;
  attachments: string[];
  env: Env;
  hall: string;
}

export interface FactToken {
  hash: string;
  facts: HandoverFacts;
}

export type InvalidReason = 'env' | 'location';

export interface Signature {
  id: string;
  role: Role;
  aspect: Aspect;
  stage: Stage;
  actor: string;
  signedAt: number;
  token: FactToken;
  /** 快照失效后不删除原签字（留痕），而是标记失效原因与时间。 */
  invalidated?: { reason: InvalidReason; at: number };
}

export type Severity = 'minor' | 'major';

export interface Discrepancy {
  id: string;
  exhibitId: string;
  stage: Stage;
  /** 差异落在哪一项：封条 / 包装 / 附件 / 位置。 */
  field: 'sealCode' | 'packageStatus' | 'attachments' | 'hall';
  expected: string;
  actual: string;
  title: string;
  severity: Severity;
  opinion: string;
  resolved: boolean;
  createdAt: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  facts: HandoverFacts;
  signatures: Signature[];
  discrepancies: Discrepancy[];
  /** 推进到布展阶段时冻结的到场点交快照；闭展对账的基准。 */
  arrivalSnapshot: HandoverFacts | null;
  returnRegistration: HandoverFacts | null;
  reconciledAt: number | null;
}

export interface PersistedState {
  schemaVersion: 2;
  exhibits: Exhibit[];
  queued: number;
}

// ---------- 快照与工具 ----------

export function canonicalFacts(facts: HandoverFacts): string {
  return JSON.stringify({
    sealCode: facts.sealCode.trim(),
    packageStatus: facts.packageStatus.trim(),
    attachments: facts.attachments.map((item) => item.trim()).filter(Boolean),
    env: {
      temperature: Number(facts.env.temperature),
      humidity: Number(facts.env.humidity),
      light: Number(facts.env.light)
    },
    hall: facts.hall.trim()
  });
}

/** FNV-1a 短哈希，作为快照指纹展示与比对。 */
export function factHash(facts: HandoverFacts): string {
  const text = canonicalFacts(facts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeToken(facts: HandoverFacts): FactToken {
  return { hash: factHash(facts), facts: JSON.parse(canonicalFacts(facts)) as HandoverFacts };
}

export function shortHash(token: FactToken): string {
  return token.hash.slice(0, 6);
}

export function signatureCurrent(signature: Signature, facts: HandoverFacts): boolean {
  return !signature.invalidated && signature.token.hash === factHash(facts);
}

export interface AspectState {
  current: Signature | null;
  stale: Signature[];
}

export function aspectState(exhibit: Exhibit, aspect: Aspect, stage: Stage): AspectState {
  const matched = exhibit.signatures.filter((item) => item.aspect === aspect && item.stage === stage);
  return {
    current: matched.find((item) => signatureCurrent(item, exhibit.facts)) ?? null,
    stale: matched.filter((item) => !signatureCurrent(item, exhibit.facts))
  };
}

export function activeSignatures(exhibit: Exhibit): Signature[] {
  return exhibit.signatures.filter((item) => signatureCurrent(item, exhibit.facts));
}

/**
 * 待复核项：该阶段签过字（含已失效旧签）但目前没有有效签字的核验维度。
 * 旧签字保留留痕，原角色补签后该项即移出待复核。
 */
export function pendingReconfirm(exhibit: Exhibit, stage: Stage): Aspect[] {
  return (['seal', 'environment', 'disposition'] as Aspect[]).filter((aspect) => {
    const all = exhibit.signatures.filter((item) => item.aspect === aspect && item.stage === stage);
    return all.length > 0 && !all.some((item) => signatureCurrent(item, exhibit.facts));
  });
}

/** 该阶段因快照失效而等待原角色再确认。 */
export function isUnderReview(exhibit: Exhibit): boolean {
  return pendingReconfirm(exhibit, exhibit.stage).length > 0;
}

export function canAdvance(exhibit: Exhibit): boolean {
  if (exhibit.stage === 'return') return false;
  const aspects: Aspect[] = ['seal', 'environment', 'disposition'];
  const allSigned = aspects.every(
    (aspect) => aspectState(exhibit, aspect, exhibit.stage).current !== null
  );
  const openIssues = exhibit.discrepancies.some(
    (item) => item.stage === exhibit.stage && !item.resolved
  );
  return allSigned && !openIssues;
}

export function advanceBlockedReason(exhibit: Exhibit): string {
  if (exhibit.stage === 'return') return '展品已闭展归还，无下一阶段。';
  const missing: string[] = [];
  (['seal', 'environment', 'disposition'] as Aspect[]).forEach((aspect) => {
    if (aspectState(exhibit, aspect, exhibit.stage).current === null) {
      missing.push(ASPECT_LABELS[aspect]);
    }
  });
  if (missing.length) return `尚缺当前阶段有效签字：${missing.join('、')}。`;
  if (exhibit.discrepancies.some((item) => item.stage === exhibit.stage && !item.resolved)) {
    return '当前阶段存在未解决差异，不能推进。';
  }
  return '';
}

// ---------- 闭展对账 ----------

export interface ReconcileLine {
  field: Discrepancy['field'];
  label: string;
  expected: string;
  actual: string;
  diff: boolean;
}

export const FIELD_LABELS: Record<Discrepancy['field'], string> = {
  sealCode: '封条编号',
  packageStatus: '包装状态',
  attachments: '附件清单',
  hall: '展品位置'
};

function normalize(value: string): string {
  return value.trim();
}

function attachmentText(list: string[]): string {
  return list.map((item) => item.trim()).filter(Boolean).join('；');
}

/** 拿归还登记与到场点交快照逐项对账（温度/湿度/照度不在差异范围）。 */
export function reconcileLines(arrival: HandoverFacts, ret: HandoverFacts): ReconcileLine[] {
  const pairs: Array<[Discrepancy['field'], string, string]> = [
    ['sealCode', normalize(arrival.sealCode), normalize(ret.sealCode)],
    ['packageStatus', normalize(arrival.packageStatus), normalize(ret.packageStatus)],
    ['attachments', attachmentText(arrival.attachments), attachmentText(ret.attachments)],
    ['hall', normalize(arrival.hall), normalize(ret.hall)]
  ];
  return pairs.map(([field, expected, actual]) => ({
    field,
    label: FIELD_LABELS[field],
    expected: expected || '—',
    actual: actual || '—',
    diff: expected !== actual
  }));
}

/** 差异项保留原处理意见：沿用同展品同项原差异的借展方意见。 */
export function carryOpinion(exhibit: Exhibit, field: Discrepancy['field']): string {
  const prior = exhibit.discrepancies
    .filter((item) => item.field === field && item.opinion.trim())
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return prior ? prior.opinion : '';
}

export function buildReturnDiscrepancies(exhibit: Exhibit, now: number): Discrepancy[] {
  if (!exhibit.arrivalSnapshot || !exhibit.returnRegistration) return [];
  return reconcileLines(exhibit.arrivalSnapshot, exhibit.returnRegistration)
    .filter((line) => line.diff)
    .map((line, index) => ({
      id: `d-${exhibit.id}-ret-${line.field}-${now}-${index}`,
      exhibitId: exhibit.id,
      stage: 'return' as Stage,
      field: line.field,
      expected: line.expected,
      actual: line.actual,
      title: `归还对账：${line.label}与到场点交不一致`,
      severity: line.field === 'attachments' ? ('major' as Severity) : ('minor' as Severity),
      opinion: carryOpinion(exhibit, line.field),
      resolved: false,
      createdAt: now
    }));
}

// ---------- 旧数据迁移（v1 -> v2） ----------
// 已有数据升级后仍要能读回：localStorage 里的旧结构（signed: string[]）
// 在加载时一次性升级为带快照的签字记录，不丢业务数据。

interface V1Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed?: string[];
  environment: Env;
}

interface V1State {
  exhibits: V1Exhibit[];
  discrepancies: Array<{
    id: string;
    exhibitId: string;
    title: string;
    severity: Severity;
    resolved: boolean;
  }>;
  queued: number;
}

const ROLE_BY_LABEL: Record<string, Role> = {
  保管员: 'keeper',
  布展负责人: 'installer',
  借展方: 'lender'
};

function guessField(title: string): Discrepancy['field'] {
  if (title.includes('封条')) return 'sealCode';
  if (title.includes('箱') || title.includes('包装') || title.includes('磕碰')) return 'packageStatus';
  if (title.includes('附件')) return 'attachments';
  if (title.includes('位置') || title.includes('展厅') || title.includes('柜')) return 'hall';
  return 'packageStatus';
}

const MIGRATED_AT = new Date('2026-01-01T00:00:00').getTime();

export function isV2State(value: unknown): value is PersistedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as PersistedState).schemaVersion === 2 &&
    Array.isArray((value as PersistedState).exhibits)
  );
}

export function migrateV1(raw: V1State): PersistedState {
  const exhibits: Exhibit[] = raw.exhibits.map((old) => {
    const facts: HandoverFacts = {
      sealCode: `SEAL-${old.code}`,
      packageStatus: '木箱完好，封条完整（升级补录）',
      attachments: ['交接单', '照片记录'],
      env: { ...old.environment },
      hall: old.hall
    };
    const signatures: Signature[] = (old.signed ?? [])
      .map((label): Role | null => ROLE_BY_LABEL[label] ?? null)
      .filter((role): role is Role => role !== null)
      .map((role, index) => ({
        id: `sig-${old.id}-mig-${index}`,
        role,
        aspect: ROLE_SCOPE[role],
        // 旧签字只发生在到场点交阶段。
        stage: 'arrival' as Stage,
        actor: ROLE_LABELS[role],
        signedAt: MIGRATED_AT,
        token: makeToken(facts)
      }));
    return {
      id: old.id,
      code: old.code,
      name: old.name,
      lender: old.lender,
      hall: old.hall,
      stage: old.stage,
      status: old.status,
      facts,
      signatures,
      discrepancies: [],
      // 旧数据已经走过到场点交：用当前事实补一份基准快照，保证仍可对账。
      arrivalSnapshot:
        old.stage === 'arrival' && !signatures.some((item) => item.aspect === 'seal')
          ? null
          : makeToken(facts).facts,
      returnRegistration: null,
      reconciledAt: null
    };
  });

  const discrepancies: Discrepancy[] = (raw.discrepancies ?? []).map((old) => {
    const field = guessField(old.title);
    return {
      id: old.id,
      exhibitId: old.exhibitId,
      stage: 'arrival',
      field,
      expected: '',
      actual: '',
      title: old.title,
      severity: old.severity,
      opinion: '',
      resolved: old.resolved,
      createdAt: MIGRATED_AT
    };
  });

  discrepancies.forEach((item) => {
    const exhibit = exhibits.find((entry) => entry.id === item.exhibitId);
    if (exhibit) exhibit.discrepancies.push(item);
  });

  return { schemaVersion: 2, exhibits, queued: raw.queued ?? 0 };
}

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'yf54-exhibition-state';
