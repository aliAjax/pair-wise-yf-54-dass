<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import {
  useExhibitionStore,
  ROLE_LABEL,
  KIND_LABEL,
  environmentOk,
  type Exhibit,
  type Role,
  type SignKind
} from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const signError = ref('');

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }

/** 当前展品某签字项是否已签署且有效 */
function signedOf(item: Exhibit, kind: SignKind) {
  return item.signed.find((sig) => sig.kind === kind);
}
function staleOf(item: Exhibit, kind: SignKind) {
  const sig = signedOf(item, kind);
  return Boolean(sig?.stale);
}

/** 分头核验签字：保管员签封条、布展负责人签环境、借展方签意见，越权代签拒绝 */
function doSign(item: Exhibit, role: Role, kind: SignKind) {
  signError.value = '';
  const opinion = kind === 'opinion' ? window.prompt('请填写差异处理意见', '') ?? '' : undefined;
  if (kind === 'opinion' && opinion === null) return;
  const result = store.sign(item.id, role, kind, opinion || undefined);
  if (!result.ok) signError.value = result.reason ?? '签字被拒绝';
}

/** 环境条件更新：旧签字快照失效，退回待复核 */
function editEnvironment(item: Exhibit) {
  const temperature = Number(window.prompt('温度（℃）', String(item.environment.temperature)));
  const humidity = Number(window.prompt('湿度（%）', String(item.environment.humidity)));
  const light = Number(window.prompt('照度（lux）', String(item.environment.light)));
  if ([temperature, humidity, light].some((n) => Number.isNaN(n))) return;
  store.updateEnvironment(item.id, { temperature, humidity, light });
}

/** 展品位置更新：旧签字快照失效，退回待复核 */
function editHall(item: Exhibit) {
  const hall = window.prompt('展厅/柜位', item.hall);
  if (hall === null || hall.trim() === '') return;
  store.updateHall(item.id, hall.trim());
}

/** 闭展归还登记：以归还登记与到场点交快照逐项对账 */
function doReturn(item: Exhibit) {
  if (!item.arrivalSnapshot) return;
  const sealIntact = window.confirm('封条是否完好？确定为完好，取消为破损');
  const hall = window.prompt('归还展位', item.arrivalSnapshot.hall) ?? item.arrivalSnapshot.hall;
  const temperature = Number(window.prompt('归还温度（℃）', String(item.arrivalSnapshot.environment.temperature)));
  const humidity = Number(window.prompt('归还湿度（%）', String(item.arrivalSnapshot.environment.humidity)));
  const light = Number(window.prompt('归还照度（lux）', String(item.arrivalSnapshot.environment.light)));
  if ([temperature, humidity, light].some((n) => Number.isNaN(n))) return;
  store.registerReturn(item.id, {
    sealIntact,
    hall,
    environment: { temperature, humidity, light }
  });
}

function statusColor(status: Exhibit['status']) {
  return { issue: 'red', passed: 'green', pending: 'grey', recheck: 'orange' }[status];
}
function statusLabel(status: Exhibit['status']) {
  return { issue: '异常', passed: '通过', pending: '待检', recheck: '待复核' }[status];
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待复核</div><div class="metric warn">{{ store.pendingRecheck }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="statusColor(item.status)">{{ statusLabel(item.status) }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>{{ item.code }}</td>
                    <td>{{ item.environment.temperature }}℃</td>
                    <td>{{ item.environment.humidity }}%</td>
                    <td>{{ item.environment.light }} lux</td>
                    <td>
                      <v-chip size="small" :color="environmentOk(item.environment) ? 'green' : 'red'">
                        {{ environmentOk(item.environment) ? '达标' : '超限' }}
                      </v-chip>
                    </td>
                    <td>
                      <v-btn size="small" variant="text" @click="editEnvironment(item)">更新环境</v-btn>
                      <v-btn size="small" variant="text" @click="editHall(item)">更新位置</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id">
                  <v-list-item-title>{{ item.title }}</v-list-item-title>
                  <v-list-item-subtitle>
                    展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}
                    <span v-if="item.origin === 'return'"> · 闭展归还</span>
                    <span v-if="item.opinion"> · 原处理意见：{{ item.opinion }}</span>
                  </v-list-item-subtitle>
                  <template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="720" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="signError" type="error" variant="tonal" class="mb-3">{{ signError }}</v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green">
                  <b>保管员 · 包装封条</b>
                  <p>核对包装、封条和附件清单，仅保管员可签。</p>
                  <v-btn size="small" :color="staleOf(selected, 'seal') ? 'orange' : 'green'" :disabled="Boolean(signedOf(selected, 'seal')) && !staleOf(selected, 'seal')" @click="doSign(selected, 'custodian', 'seal')">
                    {{ staleOf(selected, 'seal') ? '待复核 · 重新确认' : signedOf(selected, 'seal') ? '已签字' : '保管员签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="purple">
                  <b>布展负责人 · 环境条件</b>
                  <p>确认温湿度与照度，仅布展负责人可签。</p>
                  <v-btn size="small" :color="staleOf(selected, 'environment') ? 'orange' : 'deep-purple'" :disabled="Boolean(signedOf(selected, 'environment')) && !staleOf(selected, 'environment')" @click="doSign(selected, 'installer', 'environment')">
                    {{ staleOf(selected, 'environment') ? '待复核 · 重新确认' : signedOf(selected, 'environment') ? '已签字' : '布展负责人签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="orange">
                  <b>借展方 · 差异处理意见</b>
                  <p>确认差异项及处理意见，仅借展方可签。</p>
                  <v-btn size="small" :color="staleOf(selected, 'opinion') ? 'orange' : 'orange-darken-2'" :disabled="Boolean(signedOf(selected, 'opinion')) && !staleOf(selected, 'opinion')" @click="doSign(selected, 'borrower', 'opinion')">
                    {{ staleOf(selected, 'opinion') ? '待复核 · 重新确认' : signedOf(selected, 'opinion') ? '已签字' : '借展方签字' }}
                  </v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="deep-purple">
                  <b>推进阶段</b>
                  <p>三类签字齐全且无失效、无未解决差异方可推进。</p>
                  <v-btn size="small" color="deep-purple" @click="store.advance(selected.id)">推进到下一阶段</v-btn>
                </v-timeline-item>
                <v-timeline-item v-if="selected.stage === 'return' && selected.arrivalSnapshot" dot-color="blue">
                  <b>闭展归还</b>
                  <p>以归还登记与到场点交快照逐项对账，差异落到差异项并保留原处理意见。</p>
                  <v-btn size="small" color="blue" @click="doReturn(selected)">登记归还并对账</v-btn>
                </v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
</style>
