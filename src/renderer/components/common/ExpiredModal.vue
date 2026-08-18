<template>
  <div
    v-if="settingsStore.expired"
    class="fixed inset-0 z-[99999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
  >
    <div
      class="w-[400px] rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-8 text-center shadow-2xl"
    >
      <i class="ri-time-line text-5xl text-amber-500 mb-4" />
      <h2 class="text-xl font-bold text-neutral-900 dark:text-white mb-2">
        {{ t('expiry.title') }}
      </h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-6">
        {{ t('expiry.message') }}
      </p>
      <button
        class="w-full rounded-full bg-primary px-6 py-3 text-sm font-medium text-white hover:bg-primary/90 transition-all shadow-lg"
        @click="openReleasePage"
      >
        {{ t('expiry.goUpdate') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

import { useSettingsStore } from '@/store/modules/settings';

const { t } = useI18n();
const settingsStore = useSettingsStore();

const openReleasePage = () => {
  window.open('https://github.com/sdlyzhuangd/AlgerMusicPlayer-sdly/releases', '_blank');
};
</script>
