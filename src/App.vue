<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import {
  ASPECT_LABELS,
  ROLE_LABELS,
  STAGE_LABELS,
  FIELD_LABELS,
  shortHash
} from './services/handover';
import {
  activeSignatures,
  aspectState,
  canAdvance,
  isUnderReview,
  pendingReconfirm,
  reconcileLines,
  useExhibitionStore,
  type Discrepancy,
  type Exhibit,
  type HandoverFacts,
  type Role
} from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selectedId = ref<string | null>(null);
const currentRole = ref<Role>('keeper');
const roles: Role[] = ['keeper', 'installer', 'lender'];
const apiLabel = computed(() => String(api.defaults.baseURL));

const schema = toTypedSchema(
  z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) })
);
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const submit = handleSubmit((values) => {
  store.addExhibit(values);
  dialog.value = false;
  resetForm();
});

const selected = computed<Exhibit | null>(() =>
  selectedId.value ? store.byId(selectedId.value) ?? null : null
);

// 保管员封条核验表单
const sealCodeDraft = ref('');
const packageDraft = ref('');
const attachmentDraft = ref('');
// 归还登记表单
const returnDraft = ref<HandoverFacts | null>(null);
const reconcileResult = ref<{ added: number } | null>(null);

function openExhibit(item: Exhibit) {
  selectedId.value = item.id;
  reconcileResult.value = null;
  sealCodeDraft.value = item.facts.sealCode;
  packageDraft.value = item.facts.packageStatus;
  attachmentDraft.value = item.facts.attachments.join('；');
  returnDraft.value = item.returnRegistration
    ? JSON.parse(JSON.stringify(item.returnRegistration))
    : JSON.parse(JSON.stringify(item.facts));
}

function notice(): string {
  return store.lastError || store.lastWarning;
}
function noticeType(): 'error' | 'warning' {
  return store.lastError ? 'error' : 'warning';
}
function dismissNotice() {
  store.clearNotice();
}

function run<T extends { ok: boolean }>(action: () => T): T {
  const result = action();
  if (!result.ok) {
    // 错误已写入 store.lastError，界面顶部报警展示。
  }
  return result;
}

function saveSeal(item: Exhibit) {
  run(() =>
    store.updateSeal(item.id, currentRole.value, {
      sealCode: sealCodeDraft.value.trim(),
      packageStatus: packageDraft.value.trim(),
      attachments: attachmentDraft.value.split(/[;；]/).map((v) => v.trim()).filter(Boolean)
    })
  );
}

function setEnv(item: Exhibit, patch: Partial<HandoverFacts['env']>) {
  run(() => store.updateEnvironment(item.id, currentRole.value, patch));
}
function envInput(item: Exhibit, key: keyof HandoverFacts['env'], value: unknown) {
  setEnv(item, { [key]: Number(value) } as Partial<HandoverFacts['env']>);
}

function moveLocation(item: Exhibit, target: unknown) {
  const hall = String(target ?? '');
  if (!hall.trim() || hall.trim() === item.facts.hall) return;
  run(() => store.updateLocation(item.id, hall.trim(), currentRole.value));
}

function closeDialog(value: unknown) {
  if (!value) selectedId.value = null;
}

function sign(item: Exhibit) {
  run(() => store.sign(item.id, currentRole.value, ROLE_LABELS[currentRole.value]));
}

function advance(item: Exhibit) {
  run(() => store.advance(item.id));
}

function doRegisterReturn(item: Exhibit) {
  if (!returnDraft.value) return;
  run(() => store.registerReturn(item.id, returnDraft.value as HandoverFacts));
}

function stageDiscrepancies(item: Exhibit) {
  return item.discrepancies.filter((entry) => entry.stage === item.stage);
}

function doReconcile(item: Exhibit) {
  const result = store.reconcileReturn(item.id);
  if (result.ok) reconcileResult.value = { added: result.added ?? 0 };
}

function setReturnField(field: Discrepancy['field'], value: unknown) {
  if (!returnDraft.value) return;
  if (field === 'attachments') {
    returnDraft.value.attachments = String(value)
      .split(/[;；]/)
      .map((part) => part.trim())
      .filter(Boolean);
  } else {
    returnDraft.value[field] = String(value ?? '');
  }
}

const draftLines = computed(() => {
  if (!selected.value?.arrivalSnapshot || !returnDraft.value) return [];
  return reconcileLines(selected.value.arrivalSnapshot, returnDraft.value);
});

function statusColor(item: Exhibit): string {
  if (isUnderReview(item) || item.status === 'review') return 'orange';
  if (item.status === 'issue') return 'red';
  if (item.status === 'passed') return 'green';
  return 'grey';
}
function statusLabel(item: Exhibit): string {
  if (isUnderReview(item) || item.status === 'review') return '待复核';
  return { pending: '待核验', passed: '通过', issue: '有差异', review: '待复核' }[item.status];
}

const discrepancies = computed<Array<Discrepancy & { exhibitCode: string }>>(() =>
  store.exhibits.flatMap((item) =>
    item.discrepancies.map((d) => ({ ...d, exhibitCode: item.code }))
  )
);

function signLine(item: Exhibit, aspect: keyof typeof ASPECT_LABELS) {
  return aspectState(item, aspect, item.stage);
}

function currentHash(item: Exhibit): string {
  const current = activeSignatures(item)[0];
  return current ? shortHash(current.token) : '—';
}

function newDiscrepancyDraft() {
  return {
    field: 'sealCode' as Discrepancy['field'],
    actual: '',
    title: '',
    severity: 'minor' as Discrepancy['severity'],
    opinion: '',
    open: false
  };
}
const discrepancyDraft = ref(newDiscrepancyDraft());

function openNewDiscrepancy(_item: Exhibit) {
  discrepancyDraft.value = newDiscrepancyDraft();
  discrepancyDraft.value.open = true;
}

function submitDiscrepancy(item: Exhibit) {
  const draft = discrepancyDraft.value;
  const expected =
    draft.field === 'attachments'
      ? item.facts.attachments.join('；')
      : String(item.facts[draft.field] ?? '');
  const result = store.addDiscrepancy(
    item.id,
    {
      field: draft.field,
      expected,
      actual: draft.actual,
      title: draft.title || `${FIELD_LABELS[draft.field]}差异`,
      severity: draft.severity,
      opinion: draft.opinion
    },
    currentRole.value
  );
  if (result.ok) draft.open = false;
}

const opinionDrafts = ref<Record<string, string>>({});
function opinionOf(d: Discrepancy): string {
  return opinionDrafts.value[d.id] ?? d.opinion;
}
function saveOpinion(d: Discrepancy) {
  run(() => store.updateDiscrepancyOpinion(d.id, opinionDrafts.value[d.id] ?? d.opinion, currentRole.value));
}
function resolve(d: Discrepancy) {
  run(() => store.resolveDiscrepancy(d.id, currentRole.value));
}

const RETURN_FIELDS: Array<{ field: Discrepancy['field']; key: keyof HandoverFacts | 'attachments' }> = [
  { field: 'sealCode', key: 'sealCode' },
  { field: 'packageStatus', key: 'packageStatus' },
  { field: 'attachments', key: 'attachments' },
  { field: 'hall', key: 'hall' }
];
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-btn-toggle v-model="currentRole" mandatory color="white" divided variant="outlined" density="compact" class="mr-3">
        <v-btn v-for="role in roles" :key="role" :value="role" size="small">{{ ROLE_LABELS[role] }}</v-btn>
      </v-btn-toggle>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>

    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="notice()" :type="noticeType()" class="mb-4" closable @click:close="dismissNotice">
          {{ notice() }}
        </v-alert>
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中 / 闭展归还</div><div class="metric">{{ store.stageCounts.install }} / {{ store.stageCounts.return }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待复核（快照失效）</div><div class="metric" :class="{ warn: store.reviewCount }">{{ store.reviewCount }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异 / 本地待同步</div><div class="metric" :class="{ warn: store.unresolved }">{{ store.unresolved }} / {{ store.queued }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <!-- 到场点交 / 阶段签字 -->
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="118">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="openExhibit(item)">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>
                      {{ item.name }} · {{ item.code }}
                      <v-chip size="x-small" class="ml-2" :color="statusColor(item)" variant="flat" label>{{ statusLabel(item) }}</v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>
                      {{ item.lender }} · {{ item.facts.hall }} · {{ STAGE_LABELS[item.stage] }}
                      · 当前事实 {{ currentHash(item) }}
                      <v-icon v-if="isUnderReview(item)" color="orange" size="small" icon="mdi-alert-refresh" />
                    </v-list-item-subtitle>
                    <template #append>
                      <div class="text-caption text-grey-darken-1 pa-2">
                        <div v-for="aspect in ['seal', 'environment', 'disposition'] as const" :key="aspect" class="d-flex align-center">
                          <v-icon size="small" :color="signLine(item, aspect).current ? 'green' : 'grey'" :icon="signLine(item, aspect).current ? 'mdi-check-circle' : 'mdi-circle-outline'" />
                          <span :class="{ 'text-orange-darken-2': signLine(item, aspect).stale.length }">{{ ASPECT_LABELS[aspect] }}</span>
                          <v-tooltip v-if="signLine(item, aspect).current">
                            <template #activator="{ props }">
                              <v-chip v-bind="props" size="x-small" class="ml-1" label variant="text">{{ signLine(item, aspect).current!.actor }} · {{ shortHash(signLine(item, aspect).current!.token) }}</v-chip>
                            </template>
                            签字时间 {{ new Date(signLine(item, aspect).current!.signedAt).toLocaleString() }}
                          </v-tooltip>
                          <v-chip v-else-if="signLine(item, aspect).stale.length" size="x-small" class="ml-1" color="orange" label>快照失效待重签</v-chip>
                          <v-chip v-else size="x-small" class="ml-1" label variant="text">未签</v-chip>
                        </div>
                      </div>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <!-- 环境条件（仅布展负责人可写） -->
            <v-window-item value="environment">
              <v-table>
                <thead>
                  <tr><th>展品</th><th>位置</th><th>温度</th><th>湿度</th><th>照度</th><th>环境签字</th></tr>
                </thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>{{ item.code }}</td>
                    <td>
                      <v-edit-dialog :model-value="item.facts.hall" @update:model-value="moveLocation(item, $event)">
                        {{ item.facts.hall }}
                        <template #input><v-text-field :model-value="item.facts.hall" label="位置" single-line autofocus /></template>
                      </v-edit-dialog>
                    </td>
                    <td>
                      <v-edit-dialog :model-value="String(item.facts.env.temperature)" @update:model-value="envInput(item, 'temperature', $event)">
                        {{ item.facts.env.temperature }}℃
                        <template #input><v-text-field :model-value="item.facts.env.temperature" type="number" label="温度℃" single-line autofocus /></template>
                      </v-edit-dialog>
                    </td>
                    <td>
                      <v-edit-dialog :model-value="String(item.facts.env.humidity)" @update:model-value="envInput(item, 'humidity', $event)">
                        {{ item.facts.env.humidity }}%
                        <template #input><v-text-field :model-value="item.facts.env.humidity" type="number" label="湿度%" single-line autofocus /></template>
                      </v-edit-dialog>
                    </td>
                    <td>
                      <v-edit-dialog :model-value="String(item.facts.env.light)" @update:model-value="envInput(item, 'light', $event)">
                        {{ item.facts.env.light }} lux
                        <template #input><v-text-field :model-value="item.facts.env.light" type="number" label="照度 lux" single-line autofocus /></template>
                      </v-edit-dialog>
                    </td>
                    <td>
                      <v-chip v-if="signLine(item, 'environment').current" size="small" color="green">已签 {{ shortHash(signLine(item, 'environment').current!.token) }}</v-chip>
                      <v-chip v-else-if="signLine(item, 'environment').stale.length" size="small" color="orange">快照失效</v-chip>
                      <v-chip v-else size="small" disabled>未签</v-chip>
                    </td>
                  </tr>
                </tbody>
              </v-table>
              <p class="text-caption text-grey-darken-1 pa-3 mb-0">
                提示：温度/湿度/照度或位置一经更新，基于旧事实的签字快照立即失效，展品退回待复核，须由原角色重新签字后才能继续推进。
                当前操作身份：{{ ROLE_LABELS[currentRole] }}（非布展负责人修改会被拒绝）。
              </p>
            </v-window-item>

            <!-- 差异项（处理意见仅借展方可写） -->
            <v-window-item value="discrepancy">
              <v-list lines="two">
                <template v-for="d in discrepancies" :key="d.id">
                  <v-list-item>
                    <template #prepend>
                      <v-icon :color="d.resolved ? 'green' : d.severity === 'major' ? 'red' : 'orange'">
                        {{ d.resolved ? 'mdi-check-circle' : 'mdi-alert-circle' }}
                      </v-icon>
                    </template>
                    <v-list-item-title>
                      [{{ STAGE_LABELS[d.stage] }}] {{ d.title }}
                      <v-chip size="x-small" class="ml-2" label>{{ d.exhibitCode }} · {{ FIELD_LABELS[d.field] }}</v-chip>
                      <v-chip size="x-small" class="ml-1" :color="d.severity === 'major' ? 'red' : 'amber'" label>{{ d.severity === 'major' ? '重大' : '轻微' }}</v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>
                      点交记录：{{ d.expected || '—' }} → 实际：{{ d.actual || '—' }}
                      <div class="d-flex align-center mt-1 ga-2">
                        <v-text-field
                          :model-value="opinionOf(d)"
                          @update:model-value="opinionDrafts[d.id] = $event"
                          density="compact" hide-details variant="outlined"
                          placeholder="借展方差异处理意见" style="max-width: 420px"
                          :disabled="d.resolved"
                        />
                        <v-btn size="small" variant="tonal" :disabled="d.resolved || currentRole !== 'lender'" @click="saveOpinion(d)">保存意见</v-btn>
                        <v-btn size="small" color="green" variant="tonal" :disabled="d.resolved || currentRole !== 'lender'" @click="resolve(d)">{{ d.resolved ? '已解决' : '借展方确认解决' }}</v-btn>
                      </div>
                    </v-list-item-subtitle>
                  </v-list-item>
                  <v-divider />
                </template>
                <v-list-item v-if="!discrepancies.length">
                  <v-list-item-subtitle>暂无差异项。</v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <!-- 登记新展品 -->
        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text>
              <v-form @submit.prevent="submit">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" />
                <v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <!-- 展品核验详情 -->
        <v-dialog :model-value="Boolean(selected)" max-width="860" @update:model-value="closeDialog($event)">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-item>
              <v-chip size="small" :color="statusColor(selected)" label>{{ statusLabel(selected) }}</v-chip>
              <v-chip size="small" class="ml-2" label variant="outlined">{{ STAGE_LABELS[selected.stage] }}</v-chip>
              <v-chip size="small" class="ml-2" label variant="outlined">当前事实 {{ selected.facts.sealCode }} / {{ selected.facts.hall }}</v-chip>
            </v-card-item>
            <v-card-text>
              <v-alert v-if="isUnderReview(selected)" type="warning" class="mb-4" icon="mdi-alert-refresh">
                环境条件或展品位置更新后，旧签字快照已失效，展品退回待复核。待原角色重新确认：
                <b>{{ pendingReconfirm(selected, selected.stage).map((a) => ASPECT_LABELS[a]).join('、') }}</b>
              </v-alert>

              <!-- 保管员：包装封条 -->
              <v-card variant="tonal" class="mb-3" :color="currentRole === 'keeper' ? 'brown-lighten-5' : 'grey-lighten-5'">
                <v-card-text>
                  <div class="d-flex align-center mb-2">
                    <v-icon color="brown-darken-2" class="mr-2">mdi-package-variant-closed</v-icon>
                    <b>包装封条（保管员）</b>
                    <v-spacer />
                    <v-chip v-if="signLine(selected, 'seal').current" size="small" color="green" label>
                      {{ signLine(selected, 'seal').current!.actor }} 已签 · {{ shortHash(signLine(selected, 'seal').current!.token) }}
                    </v-chip>
                    <v-chip v-else-if="signLine(selected, 'seal').stale.length" size="small" color="orange" label>旧签失效，待保管员重签</v-chip>
                    <v-chip v-else size="small" label>未签</v-chip>
                  </div>
                  <v-row dense>
                    <v-col cols="12" md="4"><v-text-field v-model="sealCodeDraft" density="compact" label="封条编号" :readonly="currentRole !== 'keeper' || Boolean(signLine(selected, 'seal').current)" /></v-col>
                    <v-col cols="12" md="4"><v-text-field v-model="packageDraft" density="compact" label="包装状态" :readonly="currentRole !== 'keeper' || Boolean(signLine(selected, 'seal').current)" /></v-col>
                    <v-col cols="12" md="4"><v-text-field v-model="attachmentDraft" density="compact" label="附件（以；分隔）" :readonly="currentRole !== 'keeper' || Boolean(signLine(selected, 'seal').current)" /></v-col>
                  </v-row>
                  <div class="d-flex ga-2">
                    <v-btn size="small" :disabled="currentRole !== 'keeper' || Boolean(signLine(selected, 'seal').current)" @click="saveSeal(selected)">保管员保存核验</v-btn>
                    <v-btn size="small" color="brown-darken-2" variant="tonal" :disabled="currentRole !== 'keeper' || Boolean(signLine(selected, 'seal').current)" @click="sign(selected)">保管员签字</v-btn>
                  </div>
                </v-card-text>
              </v-card>

              <!-- 布展负责人：环境条件 -->
              <v-card variant="tonal" class="mb-3" :color="currentRole === 'installer' ? 'blue-lighten-5' : 'grey-lighten-5'">
                <v-card-text>
                  <div class="d-flex align-center mb-2">
                    <v-icon color="blue-darken-2" class="mr-2">mdi-thermometer-lines</v-icon>
                    <b>环境条件（布展负责人）</b>
                    <v-spacer />
                    <v-chip v-if="signLine(selected, 'environment').current" size="small" color="green" label>
                      {{ signLine(selected, 'environment').current!.actor }} 已签 · {{ shortHash(signLine(selected, 'environment').current!.token) }}
                    </v-chip>
                    <v-chip v-else-if="signLine(selected, 'environment').stale.length" size="small" color="orange" label>旧签失效，待布展负责人重签</v-chip>
                    <v-chip v-else size="small" label>未签</v-chip>
                  </div>
                  <v-row dense>
                    <v-col cols="4"><v-text-field :model-value="selected.facts.env.temperature" @update:model-value="envInput(selected, 'temperature', $event)" type="number" density="compact" label="温度℃" :readonly="currentRole !== 'installer'" /></v-col>
                    <v-col cols="4"><v-text-field :model-value="selected.facts.env.humidity" @update:model-value="envInput(selected, 'humidity', $event)" type="number" density="compact" label="湿度%" :readonly="currentRole !== 'installer'" /></v-col>
                    <v-col cols="4"><v-text-field :model-value="selected.facts.env.light" @update:model-value="envInput(selected, 'light', $event)" type="number" density="compact" label="照度 lux" :readonly="currentRole !== 'installer'" /></v-col>
                  </v-row>
                  <v-btn size="small" color="blue-darken-2" variant="tonal" :disabled="currentRole !== 'installer' || Boolean(signLine(selected, 'environment').current)" @click="sign(selected)">布展负责人签字</v-btn>
                </v-card-text>
              </v-card>

              <!-- 借展方：差异处理意见 -->
              <v-card variant="tonal" class="mb-3" :color="currentRole === 'lender' ? 'deep-purple-lighten-5' : 'grey-lighten-5'">
                <v-card-text>
                  <div class="d-flex align-center mb-2">
                    <v-icon color="deep-purple" class="mr-2">mdi-account-file</v-icon>
                    <b>差异处理意见（借展方）</b>
                    <v-spacer />
                    <v-chip v-if="signLine(selected, 'disposition').current" size="small" color="green" label>
                      {{ signLine(selected, 'disposition').current!.actor }} 已签 · {{ shortHash(signLine(selected, 'disposition').current!.token) }}
                    </v-chip>
                    <v-chip v-else-if="signLine(selected, 'disposition').stale.length" size="small" color="orange" label>旧签失效，待借展方重签</v-chip>
                    <v-chip v-else size="small" label>未签</v-chip>
                  </div>

                  <v-list density="compact" class="mb-2">
                    <v-list-item v-for="d in stageDiscrepancies(selected)" :key="d.id">
                      <v-list-item-title>
                        {{ d.title }}
                        <v-chip size="x-small" class="ml-1" :color="d.severity === 'major' ? 'red' : 'amber'" label>{{ d.severity === 'major' ? '重大' : '轻微' }}</v-chip>
                        <v-chip v-if="d.resolved" size="x-small" color="green" class="ml-1" label>已解决</v-chip>
                      </v-list-item-title>
                      <v-list-item-subtitle>处理意见：{{ d.opinion || '（借展方尚未填写）' }}</v-list-item-subtitle>
                      <template #append>
                        <v-btn v-if="!d.resolved" size="small" color="green" variant="tonal" :disabled="currentRole !== 'lender'" @click="resolve(d)">确认解决</v-btn>
                      </template>
                    </v-list-item>
                  </v-list>

                  <div class="d-flex ga-2 flex-wrap">
                    <v-btn size="small" variant="tonal" :disabled="currentRole !== 'lender' || Boolean(signLine(selected, 'disposition').current)" @click="openNewDiscrepancy(selected)">登记差异并填意见</v-btn>
                    <v-btn size="small" color="deep-purple" variant="tonal" :disabled="currentRole !== 'lender' || Boolean(signLine(selected, 'disposition').current)" @click="sign(selected)">借展方签字</v-btn>
                  </div>
                </v-card-text>
              </v-card>

              <!-- 闭展归还对账 -->
              <v-card v-if="selected.stage === 'return'" variant="tonal" color="teal-lighten-5" class="mb-3">
                <v-card-text>
                  <div class="d-flex align-center mb-2">
                    <v-icon color="teal-darken-2" class="mr-2">mdi-archive-check</v-icon>
                    <b>闭展归还：归还登记 × 到场点交快照逐项对账</b>
                  </div>
                  <v-simple-table v-if="selected.arrivalSnapshot" density="compact">
                    <thead>
                      <tr><th>对账项</th><th>到场点交快照</th><th>归还登记</th><th>结果</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="line in draftLines" :key="line.field">
                        <td>{{ line.label }}</td>
                        <td>{{ line.expected }}</td>
                        <td>
                          <template v-if="returnDraft">
                            <v-text-field
                              v-if="line.field !== 'attachments'"
                              :model-value="String(returnDraft[line.field])"
                              @update:model-value="setReturnField(line.field, $event)"
                              density="compact" variant="plain" hide-details
                            />
                            <v-text-field
                              v-else
                              :model-value="returnDraft.attachments.join('；')"
                              @update:model-value="returnDraft.attachments = String($event).split(/[;；]/).map(s => s.trim()).filter(Boolean)"
                              density="compact" variant="plain" hide-details
                            />
                          </template>
                        </td>
                        <td>
                          <v-chip size="x-small" :color="line.diff ? 'red' : 'green'" label>{{ line.diff ? '不一致' : '一致' }}</v-chip>
                        </td>
                      </tr>
                    </tbody>
                  </v-simple-table>
                  <p class="text-caption text-grey-darken-1 mt-2">
                    温度/湿度/照度为布展期间调控项，不参与归还对账；差异项会自动带入该展品历史同项的原处理意见。
                  </p>
                  <div class="d-flex ga-2">
                    <v-btn size="small" variant="tonal" @click="doRegisterReturn(selected)">保存归还登记</v-btn>
                    <v-btn size="small" color="teal-darken-2" variant="tonal" :disabled="!selected.returnRegistration" @click="doReconcile(selected)">逐项对账</v-btn>
                    <v-chip v-if="reconcileResult" size="small" :color="reconcileResult.added ? 'red' : 'green'" label>
                      {{ reconcileResult.added ? `对账完成，新增 ${reconcileResult.added} 项差异` : '对账完成，账实一致' }}
                    </v-chip>
                  </div>
                </v-card-text>
              </v-card>

              <!-- 阶段推进 -->
              <div class="d-flex align-center ga-3">
                <v-btn color="deep-purple" :disabled="!canAdvance(selected)" @click="advance(selected)">推进到下一阶段</v-btn>
                <span v-if="!canAdvance(selected) && selected.stage !== 'return'" class="text-caption text-red-darken-2">
                  三方当前阶段有效签字齐全且无未解决差异后才能推进
                </span>
                <span v-if="selected.arrivalSnapshot" class="text-caption text-grey-darken-1 ml-auto">
                  到场点交快照已冻结 · {{ shortHash({ hash: '', facts: selected.arrivalSnapshot }) }}
                </span>
              </div>
            </v-card-text>
          </v-card>
        </v-dialog>

        <!-- 登记差异 -->
        <v-dialog v-model="discrepancyDraft.open" max-width="520">
          <v-card title="登记差异（借展方）">
            <v-card-text v-if="selected">
              <v-select
                v-model="discrepancyDraft.field"
                :items="RETURN_FIELDS.map(f => ({ title: FIELD_LABELS[f.field], value: f.field }))"
                item-title="title" item-value="value" label="差异项" density="compact" class="mb-2"
              />
              <v-text-field v-model="discrepancyDraft.actual" label="实际情况" density="compact" class="mb-2" />
              <v-text-field v-model="discrepancyDraft.title" label="差异描述" density="compact" class="mb-2" />
              <v-select v-model="discrepancyDraft.severity" :items="[{ title: '轻微', value: 'minor' }, { title: '重大', value: 'major' }]" item-title="title" item-value="value" label="严重程度" density="compact" class="mb-2" />
              <v-textarea v-model="discrepancyDraft.opinion" label="差异处理意见" rows="3" class="mb-3" />
              <v-btn color="deep-purple" block :disabled="currentRole !== 'lender'" @click="submitDiscrepancy(selected)">提交差异与处理意见</v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 28px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
</style>
