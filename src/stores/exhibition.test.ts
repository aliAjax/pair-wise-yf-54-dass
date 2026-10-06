// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useExhibitionStore } from './exhibition';
import {
  aspectState,
  isUnderReview,
  makeToken,
  type Exhibit,
  type HandoverFacts
} from '../services/handover';

function freshExhibit(partial: Partial<Exhibit> = {}): string {
  const store = useExhibitionStore();
  const facts: HandoverFacts = {
    sealCode: 'SEAL-X1',
    packageStatus: '木箱完好',
    attachments: ['交接单'],
    env: { temperature: 20, humidity: 50, light: 150 },
    hall: 'A1 展柜'
  };
  store.exhibits = [
    {
      id: 'ex-test',
      code: 'T001',
      name: '测试展品',
      lender: '某馆',
      hall: facts.hall,
      stage: 'arrival',
      status: 'pending',
      facts,
      signatures: [],
      discrepancies: [],
      arrivalSnapshot: null,
      returnRegistration: null,
      reconciledAt: null,
      ...partial
    }
  ];
  return 'ex-test';
}

describe('越权代签拒绝', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('保管员只能签封条；签环境/代签被拒（通过操作权限映射体现）', () => {
    const store = useExhibitionStore();
    const id = freshExhibit();
    // 保管员可以签封条
    expect(store.sign(id, 'keeper', '王保管').ok).toBe(true);
    // 保管员不能改环境
    expect(store.updateEnvironment(id, 'keeper', { temperature: 25 }).ok).toBe(false);
    // 保管员不能填差异处理意见
    expect(
      store.addDiscrepancy(
        id,
        {
          field: 'sealCode',
          expected: 'SEAL-X1',
          actual: 'SEAL-X2',
          title: '封条不符',
          severity: 'major',
          opinion: '意见'
        },
        'keeper'
      ).ok
    ).toBe(false);
    // 布展负责人不能签差异处理意见（解决差异）
    expect(store.resolveDiscrepancy('d-x', 'installer').ok).toBe(false);
  });

  it('借展方只能签差异处理意见，不能改环境/位置', () => {
    const store = useExhibitionStore();
    const id = freshExhibit();
    expect(store.updateEnvironment(id, 'lender', { temperature: 30 }).ok).toBe(false);
    expect(store.updateLocation(id, 'C1 库房', 'lender').ok).toBe(false);
    expect(store.updateSeal(id, 'lender', { sealCode: 'X' }).ok).toBe(false);
  });

  it('封条已签字后不能直接修改，必须走差异项', () => {
    const store = useExhibitionStore();
    const id = freshExhibit();
    store.sign(id, 'keeper', '王保管');
    const result = store.updateSeal(id, 'keeper', { sealCode: 'SEAL-CHANGED' });
    expect(result.ok).toBe(false);
    expect(store.exhibits[0].facts.sealCode).toBe('SEAL-X1');
  });
});

describe('环境/位置更新 → 快照失效 → 待复核 → 原角色再确认', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('环境更新后旧签字失效，三方补签才能推进', () => {
    const store = useExhibitionStore();
    const id = freshExhibit();
    store.sign(id, 'keeper', '王保管');
    store.sign(id, 'installer', '李工');
    store.addDiscrepancy(
      id,
      {
        field: 'packageStatus',
        expected: '木箱完好',
        actual: '轻微划痕',
        title: '划痕',
        severity: 'minor',
        opinion: '借展方知悉并同意继续'
      },
      'lender'
    );
    const dId = store.exhibits[0].discrepancies[0].id;
    expect(store.resolveDiscrepancy(dId, 'lender').ok).toBe(true);
    expect(store.sign(id, 'lender', '张借展').ok).toBe(true); // 借展方签差异处理意见
    expect(store.advance(id).ok).toBe(true); // 到场 → 布展

    // 布展阶段：环境条件更新
    expect(
      store.updateEnvironment(id, 'installer', { temperature: 26, humidity: 62 }).ok
    ).toBe(true);
    const exhibit = store.exhibits[0];
    expect(isUnderReview(exhibit)).toBe(false); // 布展阶段还没签过字，无旧签可失效
    exhibit.status;

    // 布展三方签字
    store.sign(id, 'keeper', '王保管');
    store.sign(id, 'installer', '李工');
    store.sign(id, 'lender', '张借展'); // 无未决差异时借展方直接签处理意见

    // 位置更新 → 布展签字全部失效、退回待复核、禁止推进
    expect(store.updateLocation(id, 'B7 恒温柜', 'installer').ok).toBe(true);
    expect(store.exhibits[0].status).toBe('review');
    expect(isUnderReview(store.exhibits[0])).toBe(true);
    expect(store.advance(id).ok).toBe(false);

    // 只补一个角色仍不能推进
    store.sign(id, 'keeper', '王保管');
    expect(store.advance(id).ok).toBe(false);
    store.sign(id, 'installer', '李工');
    expect(store.advance(id).ok).toBe(false);
    store.sign(id, 'lender', '张借展');
    expect(store.advance(id).ok).toBe(true); // → 闭展归还
    expect(store.exhibits[0].stage).toBe('return');
    expect(store.exhibits[0].status).not.toBe('review');
  });
});

describe('闭展归还对账', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('归还登记与到场快照逐项对账，差异落项并保留原意见', () => {
    const store = useExhibitionStore();
    const arrival: HandoverFacts = {
      sealCode: 'SEAL-X1',
      packageStatus: '木箱完好',
      attachments: ['交接单', '底座'],
      env: { temperature: 20, humidity: 50, light: 150 },
      hall: 'A1 展柜'
    };
    const id = freshExhibit({ facts: arrival, arrivalSnapshot: makeToken(arrival).facts });
    // 到场阶段曾有封条差异及借展方意见
    store.exhibits[0].discrepancies.push({
      id: 'd-hist',
      exhibitId: id,
      stage: 'arrival',
      field: 'sealCode',
      expected: 'SEAL-X1',
      actual: 'SEAL-TEMP',
      title: '到场封条差异',
      severity: 'major',
      opinion: '原意见：封条以现场拍照为准',
      resolved: true,
      createdAt: 1
    });

    const ret: HandoverFacts = {
      ...arrival,
      sealCode: 'SEAL-RET', // 差异
      attachments: ['交接单'] // 差异：少了底座
    };
    expect(store.registerReturn(id, ret).ok).toBe(true);
    const result = store.reconcileReturn(id);
    expect(result.ok).toBe(true);
    expect(result.added).toBe(2);

    const disc = store.exhibits[0].discrepancies.filter((d) => d.stage === 'return');
    expect(disc.map((d) => d.field).sort()).toEqual(['attachments', 'sealCode']);
    // 封条差异沿用原处理意见
    expect(disc.find((d) => d.field === 'sealCode')?.opinion).toBe('原意见：封条以现场拍照为准');
    // 附件差异无历史意见，留空待借展方确认
    expect(disc.find((d) => d.field === 'attachments')?.opinion).toBe('');
    expect(store.exhibits[0].status).toBe('issue');

    // 借展方补意见后可解决
    const attachmentD = disc.find((d) => d.field === 'attachments')!;
    expect(store.resolveDiscrepancy(attachmentD.id, 'lender').ok).toBe(false); // 没意见
    store.updateDiscrepancyOpinion(attachmentD.id, '底座未随展品退回，已联系借展方追查。', 'lender');
    expect(store.resolveDiscrepancy(attachmentD.id, 'lender').ok).toBe(true);
  });

  it('无差异对账通过', () => {
    const store = useExhibitionStore();
    const facts: HandoverFacts = {
      sealCode: 'S1',
      packageStatus: '完好',
      attachments: ['清单'],
      env: { temperature: 20, humidity: 50, light: 100 },
      hall: 'A 柜'
    };
    const id = freshExhibit({ facts, arrivalSnapshot: makeToken(facts).facts });
    store.registerReturn(id, facts);
    const result = store.reconcileReturn(id);
    expect(result.added).toBe(0);
    expect(store.exhibits[0].status).toBe('passed');
  });
});

describe('持久化升级读回', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('localStorage 中的 v1 数据加载后自动迁移，且可正常继续签字', () => {
    localStorage.setItem(
      'yf54-exhibition-state',
      JSON.stringify({
        exhibits: [
          {
            id: 'ex-1',
            code: 'M001',
            name: '青铜镜 1',
            lender: '私人借展方',
            hall: 'B1',
            stage: 'arrival',
            status: 'issue',
            signed: ['保管员', '借展方'],
            environment: { temperature: 21, humidity: 52, light: 130 }
          }
        ],
        discrepancies: [
          { id: 'd1', exhibitId: 'ex-1', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
        ],
        queued: 2
      })
    );
    const store = useExhibitionStore();
    expect(store.schemaVersion).toBe(2);
    expect(store.queued).toBe(2);
    const ex = store.exhibits[0];
    expect(ex.signatures).toHaveLength(2);
    expect(aspectState(ex, 'seal', 'arrival').current?.role).toBe('keeper');
    expect(ex.discrepancies[0].field).toBe('packageStatus');
    // 迁移后仍可继续业务：布展负责人补签环境
    expect(store.sign('ex-1', 'installer', '李工').ok).toBe(true);
  });
});
