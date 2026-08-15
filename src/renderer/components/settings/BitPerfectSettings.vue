<template>
  <div class="bit-perfect-settings">
    <!-- 主开关 -->
    <setting-item
      :title="t('settings.bitPerfect.title')"
      :description="t('settings.bitPerfect.desc')"
    >
      <template #description>
        <div class="flex flex-col gap-1">
          <span class="text-neutral-500 text-xs dark:text-neutral-400">
            {{ t('settings.bitPerfect.desc') }}
          </span>
          <span v-if="!bpStore.supported" class="text-xs text-amber-500">
            {{ t('settings.bitPerfect.unsupported') }}
          </span>
          <span v-else-if="bpStore.enabled" class="text-xs text-green-500">
            {{ t('settings.bitPerfect.enabledHint') }}
          </span>
        </div>
      </template>
      <n-switch
        :value="bpStore.enabled"
        :disabled="!bpStore.supported"
        @update:value="handleToggle"
      >
        <template #checked>{{ t('common.on') }}</template>
        <template #unchecked>{{ t('common.off') }}</template>
      </n-switch>
    </setting-item>

    <!-- 输出设备选择（启用后显示） -->
    <setting-item
      v-if="bpStore.enabled"
      :title="t('settings.bitPerfect.device')"
      :description="t('settings.bitPerfect.deviceDesc')"
    >
      <s-select
        :value="bpStore.deviceId"
        :options="deviceOptions"
        width="w-64 max-md:w-full"
        @update:value="bpStore.setDeviceId"
      />
    </setting-item>

    <!-- 会话状态详情 -->
    <div
      v-if="bpStore.enabled && bpStore.session.active"
      class="mt-3 rounded-xl border border-green-500/20 bg-green-500/5 p-3"
    >
      <div class="flex items-center gap-2 mb-2">
        <span
          class="inline-block w-2 h-2 rounded-full"
          :class="bpStore.isExclusive() ? 'bg-green-500' : 'bg-yellow-500'"
        ></span>
        <span class="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {{ t('settings.bitPerfect.sessionActive') }}
        </span>
        <span
          class="px-1.5 py-0.5 text-xs rounded font-medium"
          :class="
            bpStore.isExclusive()
              ? 'bg-green-500/15 text-green-600 dark:text-green-400'
              : 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400'
          "
        >
          {{
            bpStore.isExclusive()
              ? t('settings.bitPerfect.mode.exclusive')
              : t('settings.bitPerfect.mode.shared')
          }}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <div class="flex justify-between">
          <span class="opacity-70">{{ t('settings.bitPerfect.fields.device') }}</span>
          <span class="font-medium truncate max-w-[55%]">{{
            bpStore.session.deviceName || '-'
          }}</span>
        </div>
        <div class="flex justify-between">
          <span class="opacity-70">{{ t('settings.bitPerfect.fields.sampleRate') }}</span>
          <span class="font-medium">{{ formatSampleRate(bpStore.session.sampleRate) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="opacity-70">{{ t('settings.bitPerfect.fields.format') }}</span>
          <span class="font-medium">{{
            formatBitDepth(bpStore.session.format, bpStore.session.sampleRate)
          }}</span>
        </div>
        <div class="flex justify-between">
          <span class="opacity-70">{{ t('settings.bitPerfect.fields.channels') }}</span>
          <span class="font-medium">{{ formatChannels(bpStore.session.channels) }}</span>
        </div>
      </div>
    </div>

    <!-- 不满足条件时的说明 -->
    <div
      v-else-if="bpStore.enabled && bpStore.supported"
      class="mt-3 rounded-xl border border-neutral-500/20 bg-neutral-500/5 p-3 text-xs text-neutral-500 dark:text-neutral-400"
    >
      {{ t('settings.bitPerfect.idleHint') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useBitPerfectStore } from '@/store/modules/bitPerfect';

import SettingItem from '../../views/set/SettingItem.vue';
import SSelect from '../../views/set/SSelect.vue';

const { t } = useI18n();
const bpStore = useBitPerfectStore();

const deviceOptions = computed(() => {
  const options = [{ label: t('settings.bitPerfect.defaultDevice'), value: 'default' }];
  for (const device of bpStore.devices) {
    options.push({ label: device.name, value: device.id });
  }
  return options;
});

const handleToggle = (value: boolean) => {
  bpStore.setEnabled(value);
};

const formatSampleRate = (rate: number): string => {
  if (!rate) return '-';
  return rate >= 1000 ? `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz` : `${rate} Hz`;
};

const formatBitDepth = (format: string, _sampleRate: number): string => {
  if (!format) return '-';
  const map: Record<string, string> = {
    u8: '8-bit',
    s16: '16-bit',
    s24: '24-bit',
    s32: '32-bit',
    f32: '32-bit Float'
  };
  return map[format] || format;
};

const formatChannels = (channels: number): string => {
  if (!channels) return '-';
  return channels === 1 ? t('settings.bitPerfect.mono') : `${channels} ch`;
};
</script>
