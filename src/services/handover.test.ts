import { describe, expect, it } from 'vitest';
import {
  activeSignatures,
  aspectState,
  buildReturnDiscrepancies,
  canAdvance,
  carryOpinion,
  factHash,
  isUnderReview,
  makeToken,
  migrateV1,
  pendingReconfirm,
  reconcileLines,
  ROLE_SCOPE,
  type Exhibit,
  type HandoverFacts,
  type Role
} from './handover';

const baseFacts = (): HandoverFacts => ({
  sealCode: 'SEAL-001',
  packageStatus: '木箱完好',
  attachments: ['交接单', '照片'],
  env: { temperature: 20, humidity: 50, light: 150 },
  hall: 'A2 温湿展柜'
});

function exhibitWithAllSigned(stage: Exhibit['stage'] = 'arrival'): Exhibit {
  const facts = baseFacts();
  const exhibit: Exhibit = {
    id: 'ex-1',
    code: 'M001',
    name: '青铜镜',
    lender: '西北博物馆',
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
  (['keeper', 'installer', 'lender'] as Role[]).forEach((role, index) => {
    exhibit.signatures.push({
      id: `sig-${role}`,
      role,
      aspect: ROLE_SCOPE[role],
      stage,
      actor: role,
      signedAt: 1000 + index,
      token: makeToken(facts)
    });
  });
  return exhibit;
}

describe('角色权限边界（领域模型）', () => {
  it('每个角色只对应一个核验维度，不能替别人签', () => {
    expect(ROLE_SCOPE.keeper).toBe('seal');
    expect(ROLE_SCOPE.installer).toBe('environment');
    expect(ROLE_SCOPE.lender).toBe('disposition');
    // 三个角色各管一摊，无任何重叠 → 谁都不能替别人签
    const aspects = Object.values(ROLE_SCOPE);
    expect(new Set(aspects).size).toBe(3);
  });
});

describe('快照失效与待复核', () => {
  it('环境条件更新后，旧签字全部失效，展品进入待复核', () => {
    const exhibit = exhibitWithAllSigned();
    expect(canAdvance(exhibit)).toBe(true);

    exhibit.facts.env.temperature = 24;

    // 所有旧签字快照指纹不再匹配
    expect(activeSignatures(exhibit)).toHaveLength(0);
    expect(isUnderReview(exhibit)).toBe(true);
    expect(pendingReconfirm(exhibit, 'arrival').sort()).toEqual(
      ['seal', 'environment', 'disposition'].sort()
    );
    expect(canAdvance(exhibit)).toBe(false);
  });

  it('位置更新后同样失效，且失效原因可从签字上留痕', () => {
    const exhibit = exhibitWithAllSigned();
    exhibit.facts.hall = 'C3 独立展柜';
    exhibit.signatures.forEach((sig) => {
      if (sig.token.hash !== factHash(exhibit.facts)) {
        sig.invalidated = { reason: 'location', at: 9999 };
      }
    });
    expect(isUnderReview(exhibit)).toBe(true);
    expect(exhibit.signatures.every((sig) => sig.invalidated?.reason === 'location')).toBe(true);
  });

  it('原角色逐一补签后待复核解除，且三项齐全才可推进', () => {
    const exhibit = exhibitWithAllSigned();
    exhibit.facts.env.humidity = 60;
    exhibit.signatures.forEach((sig) => {
      sig.invalidated = { reason: 'env', at: 9999 };
    });
    expect(canAdvance(exhibit)).toBe(false);

    // 保管员先补签
    exhibit.signatures.push({
      id: 'sig-keeper-2',
      role: 'keeper',
      aspect: 'seal',
      stage: 'arrival',
      actor: 'keeper',
      signedAt: 10000,
      token: makeToken(exhibit.facts)
    });
    expect(isUnderReview(exhibit)).toBe(true); // 仍有两项待复核
    expect(aspectState(exhibit, 'seal', 'arrival').current?.id).toBe('sig-keeper-2');
    expect(aspectState(exhibit, 'seal', 'arrival').stale).toHaveLength(1); // 旧签留痕不删

    (['installer', 'lender'] as Role[]).forEach((role) => {
      exhibit.signatures.push({
        id: `sig-${role}-2`,
        role,
        aspect: ROLE_SCOPE[role],
        stage: 'arrival',
        actor: role,
        signedAt: 10001,
        token: makeToken(exhibit.facts)
      });
    });
    expect(isUnderReview(exhibit)).toBe(false);
    expect(canAdvance(exhibit)).toBe(true);
  });

  it('未解决差异阻断推进', () => {
    const exhibit = exhibitWithAllSigned();
    exhibit.discrepancies.push({
      id: 'd1',
      exhibitId: 'ex-1',
      stage: 'arrival',
      field: 'sealCode',
      expected: 'SEAL-001',
      actual: 'SEAL-X',
      title: '封条不符',
      severity: 'major',
      opinion: '借展方处理意见',
      resolved: false,
      createdAt: 1
    });
    expect(canAdvance(exhibit)).toBe(false);
  });
});

describe('闭展归还对账', () => {
  it('逐项对账：封条/包装/附件/位置，温湿光不参与', () => {
    const arrival = baseFacts();
    const ret = baseFacts();
    ret.sealCode = 'SEAL-002';
    ret.hall = '库房 B';
    ret.env.temperature = 5; // 环境差异不计入对账项

    const lines = reconcileLines(arrival, ret);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.field === 'sealCode')?.diff).toBe(true);
    expect(lines.find((l) => l.field === 'hall')?.diff).toBe(true);
    expect(lines.filter((l) => l.diff)).toHaveLength(2);
  });

  it('差异落到差异项，并保留原处理意见', () => {
    const exhibit = exhibitWithAllSigned();
    const arrival = baseFacts();
    exhibit.arrivalSnapshot = arrival;
    // 历史上封条差异已有借展方意见
    exhibit.discrepancies.push({
      id: 'd-old',
      exhibitId: 'ex-1',
      stage: 'arrival',
      field: 'sealCode',
      expected: 'SEAL-001',
      actual: 'SEAL-OLD',
      title: '到场时封条差异',
      severity: 'major',
      opinion: '维持原封条拍照备案，借展方认可继续展出',
      resolved: true,
      createdAt: 500
    });

    const reg = baseFacts();
    reg.sealCode = 'SEAL-009';
    exhibit.returnRegistration = reg;

    const created = buildReturnDiscrepancies(exhibit, 9000);
    expect(created).toHaveLength(1);
    expect(created[0].field).toBe('sealCode');
    expect(created[0].stage).toBe('return');
    expect(created[0].opinion).toBe('维持原封条拍照备案，借展方认可继续展出');
  });

  it('无差异时不产生差异项', () => {
    const exhibit = exhibitWithAllSigned();
    exhibit.arrivalSnapshot = baseFacts();
    exhibit.returnRegistration = baseFacts();
    expect(buildReturnDiscrepancies(exhibit, 9000)).toHaveLength(0);
  });

  it('carryOpinion 取最近一次同项意见', () => {
    const exhibit = exhibitWithAllSigned();
    exhibit.discrepancies.push(
      {
        id: 'da',
        exhibitId: 'ex-1',
        stage: 'arrival',
        field: 'hall',
        expected: 'A',
        actual: 'B',
        title: 't1',
        severity: 'minor',
        opinion: '旧意见',
        resolved: true,
        createdAt: 1
      },
      {
        id: 'db',
        exhibitId: 'ex-1',
        stage: 'install',
        field: 'hall',
        expected: 'A',
        actual: 'C',
        title: 't2',
        severity: 'minor',
        opinion: '新意见',
        resolved: true,
        createdAt: 2
      }
    );
    expect(carryOpinion(exhibit, 'hall')).toBe('新意见');
    expect(carryOpinion(exhibit, 'sealCode')).toBe('');
  });
});

describe('旧数据 v1 迁移读回', () => {
  it('signed 角色名数组升级为带快照的签字记录，扁平差异挂到展品', () => {
    const v1 = {
      exhibits: [
        {
          id: 'ex-5',
          code: 'M005',
          name: '石雕佛首 5',
          lender: '私人借展方',
          hall: 'B1 开放展区',
          stage: 'arrival' as const,
          status: 'issue' as const,
          signed: ['保管员', '借展方', '陌生人'],
          environment: { temperature: 22, humidity: 55, light: 200 }
        }
      ],
      discrepancies: [
        {
          id: 'd1',
          exhibitId: 'ex-5',
          title: '封条编号与交接单不一致',
          severity: 'major' as const,
          resolved: false
        }
      ],
      queued: 3
    };

    const v2 = migrateV1(v1);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.queued).toBe(3);
    const ex = v2.exhibits[0];
    expect(ex.signatures).toHaveLength(2); // 未知角色被忽略
    expect(ex.signatures.map((s) => s.role).sort()).toEqual(['keeper', 'lender']);
    expect(ex.signatures.every((s) => Boolean(s.token.hash))).toBe(true);
    expect(ex.discrepancies).toHaveLength(1);
    expect(ex.discrepancies[0].field).toBe('sealCode');
    expect(ex.facts.env).toEqual({ temperature: 22, humidity: 55, light: 200 });
  });

  it('已过到场点交阶段的旧展品补出基准快照，保证仍可对账', () => {
    const v1 = {
      exhibits: [
        {
          id: 'ex-9',
          code: 'M009',
          name: '经卷 9',
          lender: '西北博物馆',
          hall: 'A2 温湿展柜',
          stage: 'return' as const,
          status: 'passed' as const,
          signed: ['保管员'],
          environment: { temperature: 21, humidity: 50, light: 100 }
        }
      ],
      discrepancies: [],
      queued: 0
    };
    const v2 = migrateV1(v1);
    expect(v2.exhibits[0].arrivalSnapshot).not.toBeNull();
    expect(v2.exhibits[0].arrivalSnapshot?.hall).toBe('A2 温湿展柜');
  });
});
