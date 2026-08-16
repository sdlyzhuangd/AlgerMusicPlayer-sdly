<template>
  <div
    class="music-play-bar"
    :class="[
      setAnimationClass('animate__bounceInUp'),
      musicFullVisible ? 'play-bar-opcity' : '',
      musicFullVisible && MusicFullRef?.musicFullRef?.config?.hidePlayBar
        ? 'animate__animated animate__slideOutDown'
        : ''
    ]"
    :style="{
      color: musicFullVisible
        ? textColors.theme === 'dark'
          ? '#000000'
          : '#ffffff'
        : settingsStore.theme === 'dark'
          ? '#ffffff'
          : '#000000'
    }"
  >
    <div class="music-time custom-slider">
      <n-slider
        v-model:value="timeSlider"
        :step="1"
        :max="allTime"
        :min="0"
        :format-tooltip="formatTooltip"
        :show-tooltip="showSliderTooltip"
        @mouseenter="showSliderTooltip = true"
        @mouseleave="showSliderTooltip = false"
        @dragstart="handleSliderDragStart"
        @dragend="handleSliderDragEnd"
      ></n-slider>
    </div>
    <div class="play-bar-img-wrapper" @click="setMusicFull">
      <n-image
        :src="getImgUrl(playMusic?.picUrl, '100y100')"
        class="play-bar-img"
        lazy
        preview-disabled
      />
      <div v-if="playMusic?.playLoading" class="loading-overlay">
        <i class="ri-loader-4-line loading-icon"></i>
      </div>
      <div class="hover-arrow">
        <div class="hover-content">
          <!-- <i class="ri-arrow-up-s-line text-3xl" :class="{ 'ri-arrow-down-s-line': musicFullVisible }"></i> -->
          <i
            class="text-3xl"
            :class="musicFullVisible ? 'ri-arrow-down-s-line' : 'ri-arrow-up-s-line'"
          ></i>
          <span class="hover-text">{{
            musicFullVisible ? t('player.playBar.collapse') : t('player.playBar.expand')
          }}</span>
        </div>
      </div>
    </div>
    <div class="music-content">
      <div class="music-content-title flex items-center">
        <n-ellipsis class="text-ellipsis min-w-0 flex-1" line-clamp="1">
          <p v-html="playMusic?.name || ''"></p>
        </n-ellipsis>
        <span v-if="playbackRate !== 1.0" class="playback-rate-badge"> {{ playbackRate }}x </span>
        <!-- Bit-Perfect 状态徽章：金色小锁 + WASAPI 模式 + 音频规格，悬停查看专辑/目录等详情 -->
        <n-tooltip
          v-if="bpBadgeVisible"
          trigger="hover"
          placement="top"
          :z-index="9999999"
          :content-style="bpTipContentStyle"
        >
          <template #trigger>
            <span class="bp-badge" :class="bpBadgeClass">
              <i class="ri-lock-2-fill bp-badge-lock"></i>
              <span class="bp-badge-main">{{ bpBadgeText }}</span>
              <span v-if="bpBadgeSpecs" class="bp-badge-specs">{{ bpBadgeSpecs }}</span>
            </span>
          </template>
          <div class="bp-tip">
            <div class="bp-tip-header">
              <i class="ri-lock-2-fill bp-tip-lock"></i>
              <span>{{ bpBadgeText }}</span>
            </div>
            <div class="bp-tip-body">
              <div class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.mode') }}</span>
                <span class="bp-tip-value">{{ bpModeText }}</span>
              </div>
              <div v-if="bpTipDevice" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.device') }}</span>
                <span class="bp-tip-value">{{ bpTipDevice }}</span>
              </div>
              <div class="bp-tip-divider"></div>
              <div v-if="bpAlbum" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.album') }}</span>
                <span class="bp-tip-value">{{ bpAlbum }}</span>
              </div>
              <div v-if="bpDirectory" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.directory') }}</span>
                <span class="bp-tip-value bp-tip-path">{{ bpDirectory }}</span>
              </div>
              <div class="bp-tip-divider"></div>
              <div v-if="bpFormat" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.format') }}</span>
                <span class="bp-tip-value">{{ bpFormat }}</span>
              </div>
              <div v-if="bpSampleRate" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.sampleRate') }}</span>
                <span class="bp-tip-value">{{ bpSampleRate }}</span>
              </div>
              <div v-if="bpBitDepth" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.bitDepth') }}</span>
                <span class="bp-tip-value">{{ bpBitDepth }}</span>
              </div>
              <div v-if="bpChannels" class="bp-tip-row">
                <span class="bp-tip-label">{{ t('player.playBar.bitPerfect.channels') }}</span>
                <span class="bp-tip-value">{{ bpChannels }}</span>
              </div>
            </div>
          </div>
        </n-tooltip>
        <!-- 非 BP 音频信息徽章 -->
        <span v-if="audioInfoVisible" class="audio-info-badge">
          <i class="ri-music-2-line"></i>
          <span v-if="audioInfoSpecs" class="audio-info-specs">{{ audioInfoSpecs }}</span>
        </span>
      </div>
      <div class="music-content-name">
        <n-ellipsis
          class="text-ellipsis"
          line-clamp="1"
          :tooltip="{
            contentStyle: { maxWidth: '600px' },
            zIndex: 99999
          }"
        >
          <span
            v-for="(artists, artistsindex) in artistList"
            :key="artistsindex"
            class="cursor-pointer hover:text-green-500"
            @click="handleArtistClick(artists.id)"
          >
            {{ artists.name }}{{ artistsindex < artistList.length - 1 ? ' / ' : '' }}
          </span>
        </n-ellipsis>
      </div>
    </div>
    <div class="music-buttons">
      <div class="music-buttons-prev" @click="handlePrev">
        <i class="iconfont icon-prev"></i>
      </div>
      <div class="music-buttons-play" @click="playMusicEvent">
        <i class="iconfont icon" :class="play ? 'icon-stop' : 'icon-play'"></i>
      </div>
      <div class="music-buttons-next" @click="handleNext">
        <i class="iconfont icon-next"></i>
      </div>
    </div>
    <div class="audio-button">
      <div class="audio-volume custom-slider" @wheel.prevent="handleVolumeWheel">
        <div class="volume-icon" @click="mute">
          <i class="iconfont" :class="getVolumeIcon"></i>
        </div>
        <div class="volume-slider">
          <div class="volume-percentage" :class="{ 'volume-percentage-disabled': isMuted }">
            {{ Math.round(volumeSlider) }}%
          </div>
          <n-slider
            v-model:value="volumeSlider"
            :step="0.01"
            :tooltip="false"
            :disabled="isMuted"
            vertical
          ></n-slider>
        </div>
      </div>
      <n-tooltip v-if="!isMobile" trigger="hover" :z-index="9999999">
        <template #trigger>
          <i
            class="iconfont"
            :class="[playModeIcon, { 'intelligence-active': playMode === 3 }]"
            @click="togglePlayMode"
          ></i>
        </template>
        {{ playModeText }}
      </n-tooltip>
      <n-tooltip v-if="!isMobile" trigger="hover" :z-index="9999999">
        <template #trigger>
          <i
            class="iconfont"
            :class="{
              'like-active': isFavorite,
              'ri-heart-3-fill': isFavorite,
              'ri-heart-3-line': !isFavorite
            }"
            @click="toggleFavorite"
          ></i>
        </template>
        {{ t('player.playBar.like') }}
      </n-tooltip>
      <n-tooltip v-if="isElectron" class="music-lyric" trigger="hover" :z-index="9999999">
        <template #trigger>
          <i
            class="iconfont ri-netease-cloud-music-line"
            :class="{ 'text-green-500': isLyricWindowOpen, 'disabled-icon': !playMusic?.id }"
            @click="playMusic?.id && openLyricWindow()"
          ></i>
        </template>
        {{ playMusic?.id ? t('player.playBar.lyric') : t('player.playBar.noSongPlaying') }}
      </n-tooltip>
      <n-tooltip v-if="playMusic?.id && isElectron" trigger="hover" :z-index="9999999">
        <template #trigger>
          <reparse-popover v-if="playMusic?.id" />
        </template>
        {{ t('player.playBar.reparse') }}
      </n-tooltip>
      <n-tooltip v-if="playMusic?.id && isElectron" trigger="hover" :z-index="9999999">
        <template #trigger>
          <i
            class="iconfont ri-download-line"
            :class="{ 'disabled-icon': isDownloading }"
            @click="playMusic?.id && handleDownload()"
          />
        </template>
        {{ isDownloading ? t('songItem.message.downloading') : t('player.playBar.download') }}
      </n-tooltip>

      <!-- 高级控制菜单按钮（整合了 EQ、定时关闭、播放速度） -->
      <advanced-controls-popover />

      <n-tooltip trigger="hover" :z-index="9999999">
        <template #trigger>
          <i
            class="iconfont icon-list text-2xl hover:text-green-500 transition-colors cursor-pointer"
            @click="openPlayListDrawer"
          ></i>
        </template>
        {{ t('player.playBar.playList') }}
      </n-tooltip>
    </div>
    <!-- 全屏播放器 -->
    <music-full-wrapper ref="MusicFullRef" v-model="musicFullVisible" :background="background" />
  </div>
</template>

<script lang="ts" setup>
import { useThrottleFn } from '@vueuse/core';
import { storeToRefs } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import MusicFullWrapper from '@/components/lyric/MusicFullWrapper.vue';
import AdvancedControlsPopover from '@/components/player/AdvancedControlsPopover.vue';
import ReparsePopover from '@/components/player/ReparsePopover.vue';
import {
  allTime,
  artistList,
  isLyricWindowOpen,
  nowTime,
  openLyric,
  playMusic,
  textColors
} from '@/hooks/MusicHook';
import { useArtist } from '@/hooks/useArtist';
import { useDownload } from '@/hooks/useDownload';
import { useFavorite } from '@/hooks/useFavorite';
import { usePlaybackControl } from '@/hooks/usePlaybackControl';
import { usePlayMode } from '@/hooks/usePlayMode';
import { useVolumeControl } from '@/hooks/useVolumeControl';
import { audioService, type DecodedAudioInfo } from '@/services/audioService';
import { useBitPerfectStore } from '@/store/modules/bitPerfect';
import { usePlayerStore } from '@/store/modules/player';
import { useSettingsStore } from '@/store/modules/settings';
import { getImgUrl, isElectron, isMobile, secondToMinute, setAnimationClass } from '@/utils';

const bpStore = useBitPerfectStore();
const playerStore = usePlayerStore();
const settingsStore = useSettingsStore();
const { t } = useI18n();

// ==================== Bit-Perfect 状态徽章 ====================

/** tooltip 使用自绘面板，去掉 naive 默认容器样式 */
const bpTipContentStyle = {
  padding: '0',
  background: 'transparent',
  border: 'none',
  boxShadow: 'none'
};

const bpBadgeVisible = computed(() => bpStore.session.active);

/** WASAPI 模式文本（独占 / 共享 / 降级） */
const bpModeText = computed(() => {
  const s = bpStore.session;
  const i18n = 'player.playBar.bitPerfect.';
  if (s.shareMode === 'exclusive') return t(`${i18n}exclusive`);
  if (s.shareMode === 'shared-fallback') return t(`${i18n}sharedFallback`);
  return t(`${i18n}shared`);
});

/** 徽章主文本：Bit-Perfect · WASAPI 独占/共享 */
const bpBadgeText = computed(() => {
  if (!bpBadgeVisible.value) return '';
  return `${t('player.playBar.bitPerfect.title')} · ${bpModeText.value}`;
});

/** 徽章配色：独占 = 金色发光，共享（含降级）= 暗金 */
const bpBadgeClass = computed(() =>
  bpStore.isExclusive() ? 'bp-badge-exclusive' : 'bp-badge-shared'
);

/** 当前本地文件真实路径（local:///C:/... → C:/...） */
const bpLocalFilePath = computed(() => {
  const url = playMusic.value?.playMusicUrl || '';
  if (!url.startsWith('local:///')) return '';
  try {
    let p = decodeURIComponent(url.replace('local:///', ''));
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch {
    return '';
  }
});

/** 文件容器格式（FLAC / WAV / MP3 ...） */
const bpFileFormat = computed(() => {
  const p = bpLocalFilePath.value;
  const ext = p.slice(p.lastIndexOf('.') + 1).toUpperCase();
  return ['FLAC', 'WAV', 'MP3', 'OGG', 'M4A', 'AAC', 'APE', 'ALAC'].includes(ext) ? ext : '';
});

/** 实际输出 PCM 格式（f32/s32/s24/s16 → 可读文本） */
const bpOutputFormatText = computed(() => {
  const f = bpStore.session.format;
  const map: Record<string, string> = {
    f32: 'PCM 32bit Float',
    s32: 'PCM 32bit',
    s24: 'PCM 24bit',
    s16: 'PCM 16bit',
    u8: 'PCM 8bit'
  };
  return (f && (map[f] || f.toUpperCase())) || '';
});

/** 音频格式：文件容器，缺省时回退输出 PCM 格式 */
const bpFormat = computed(() => {
  const fileFmt = bpFileFormat.value;
  const outFmt = bpOutputFormatText.value;
  if (fileFmt && outFmt && !outFmt.startsWith(fileFmt)) return `${fileFmt} · ${outFmt}`;
  return fileFmt || outFmt || '';
});

/** 采样率：优先本地元数据（文件真实规格），回退会话实际输出 */
const bpSampleRate = computed(() => {
  const rate = playMusic.value?.sampleRate || bpStore.session.sampleRate || 0;
  if (!rate) return '';
  const khz = rate / 1000;
  return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
});

/** 位深：优先本地元数据（文件真实规格），回退会话输出格式 */
const bpBitDepth = computed(() => {
  const f = bpStore.session.format;
  const depthFromFormat =
    f === 'f32' ? 32 : f === 's32' ? 32 : f === 's24' ? 24 : f === 's16' ? 16 : 0;
  const bits = playMusic.value?.bitsPerSample || depthFromFormat || 0;
  return bits ? `${bits} bit` : '';
});

/** 声道数 */
const bpChannels = computed(() => {
  const ch = bpStore.session.channels;
  return ch ? `${ch} ch` : '';
});

/** 徽章尾部规格摘要：格式 · 采样率 · 位深 · 声道 */
const bpBadgeSpecs = computed(() =>
  [bpFileFormat.value, bpSampleRate.value, bpBitDepth.value, bpChannels.value]
    .filter(Boolean)
    .join(' · ')
);

/** tooltip：专辑 */
const bpAlbum = computed(() => {
  const m = playMusic.value;
  return (
    m?.al?.name || m?.album?.name || (m?.song?.album as { name?: string } | undefined)?.name || ''
  );
});

/** tooltip：文件所在目录 */
const bpDirectory = computed(() => {
  const p = bpLocalFilePath.value;
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : '';
});

/** tooltip：输出设备 */
const bpTipDevice = computed(() => bpStore.session.deviceName || '');

// ==================== 非 BP 音频信息 ====================

const decodedAudioInfo = ref<DecodedAudioInfo>({ sampleRate: 0, channels: 0, format: '' });

audioService.on('audio-info', (info: DecodedAudioInfo) => {
  decodedAudioInfo.value = { ...info };
});

watch(() => playMusic.value?.id, () => {
  decodedAudioInfo.value = { sampleRate: 0, channels: 0, format: '' };
});

/** 非 BP 音频信息是否可显示 */
const audioInfoVisible = computed(() => {
  if (bpBadgeVisible.value) return false;
  if (!playMusic.value?.id) return false;
  return !!decodedAudioInfo.value.format || !!decodedAudioInfo.value.sampleRate;
});

const audioInfoFormat = computed(() => decodedAudioInfo.value.format || '');

const audioInfoSampleRate = computed(() => {
  const rate = playMusic.value?.sampleRate || decodedAudioInfo.value.sampleRate || 0;
  if (!rate) return '';
  const khz = rate / 1000;
  return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
});

const audioInfoBitDepth = computed(() => {
  const bits = playMusic.value?.bitsPerSample || 0;
  if (bits) return `${bits} bit`;
  return decodedAudioInfo.value.sampleRate ? '16bit+' : '';
});

const audioInfoChannels = computed(() => {
  const ch = decodedAudioInfo.value.channels;
  return ch ? `${ch} ch` : '';
});

const audioInfoSpecs = computed(() =>
  [audioInfoFormat.value, audioInfoSampleRate.value, audioInfoBitDepth.value, audioInfoChannels.value]
    .filter(Boolean)
    .join(' · ')
);

// 播放控制
const { isPlaying: play, playMusicEvent, handleNext, handlePrev } = usePlaybackControl();

// 音量控制
const {
  isMuted,
  volumeSlider,
  volumeIcon: getVolumeIcon,
  mute,
  handleVolumeWheel
} = useVolumeControl();

// 收藏
const { isFavorite, toggleFavorite } = useFavorite();

// 下载
const { downloadMusic, isDownloading } = useDownload();
const handleDownload = () => {
  if (!playMusic.value || isDownloading.value) return;
  downloadMusic(playMusic.value);
};

// 播放模式
const { playMode, playModeIcon, playModeText, togglePlayMode } = usePlayMode();

// 播放速度控制
const { playbackRate } = storeToRefs(playerStore);

// 背景颜色
const background = ref('#000');

watch(
  () => playerStore.playMusic,
  async () => {
    if (playMusic && playMusic.value && playMusic.value.backgroundColor) {
      background.value = playMusic.value.backgroundColor as string;
    }
  },
  { immediate: true, deep: true }
);

// 节流版本的 seek 函数
const throttledSeek = useThrottleFn((value: number) => {
  audioService.seek(value);
  nowTime.value = value;
}, 50);

// 拖动时的临时值
const dragValue = ref(0);
const isDragging = ref(false);

const timeSlider = computed({
  get: () => (isDragging.value ? dragValue.value : nowTime.value),
  set: (value) => {
    if (isDragging.value) {
      dragValue.value = value;
      return;
    }
    throttledSeek(value);
  }
});

const handleSliderDragStart = () => {
  isDragging.value = true;
  dragValue.value = nowTime.value;
};

const handleSliderDragEnd = () => {
  isDragging.value = false;
  audioService.seek(dragValue.value);
  nowTime.value = dragValue.value;
};

const formatTooltip = (value: number) => {
  return `${secondToMinute(value)} / ${secondToMinute(allTime.value)}`;
};

const MusicFullRef = ref<any>(null);
const showSliderTooltip = ref(false);

const musicFullVisible = computed({
  get: () => playerStore.musicFull,
  set: (value) => {
    playerStore.setMusicFull(value);
  }
});

const setMusicFull = () => {
  musicFullVisible.value = !musicFullVisible.value;
  playerStore.setMusicFull(musicFullVisible.value);
  if (musicFullVisible.value) {
    settingsStore.showArtistDrawer = false;
  }
};

const openLyricWindow = () => {
  openLyric();
};

const { navigateToArtist } = useArtist();

const handleArtistClick = (id: number) => {
  musicFullVisible.value = false;
  navigateToArtist(id);
};

const openPlayListDrawer = () => {
  playerStore.setPlayListDrawerVisible(true);
};
</script>

<style lang="scss" scoped>
.text-ellipsis {
  width: 100%;
}

.music-play-bar {
  @apply h-20 w-full absolute bottom-0 left-0 flex items-center box-border px-6 py-2 pt-3;
  @apply bg-light dark:bg-dark shadow-2xl shadow-gray-300;
  z-index: 9999;
  animation-duration: 0.5s !important;

  &.play-bar-opcity {
    @apply bg-transparent !important;
    box-shadow: 0 0 20px 5px #0000001d;
  }

  &.animate__slideOutDown {
    animation-duration: 0.3s !important;
    pointer-events: none;
  }

  .music-content {
    flex: 0 1 auto;
    min-width: 140px;
    max-width: 400px;
    @apply ml-4;

    &-title {
      @apply text-base;
    }

    &-name {
      @apply text-xs mt-1 opacity-80;
    }
  }
}

.play-bar-img {
  @apply w-14 h-14 rounded-2xl;
}

.music-buttons {
  @apply mx-6 flex-1 flex justify-center;

  .iconfont {
    @apply text-2xl transition;
    @apply hover:text-green-500;
  }

  .icon {
    @apply text-3xl;
    @apply hover:text-green-500;
  }

  @apply flex items-center;

  > div {
    @apply cursor-pointer;
  }

  &-play {
    @apply flex justify-center items-center w-20 h-12 rounded-full mx-4 transition text-gray-500;
    @apply bg-gray-100 bg-opacity-60 dark:bg-gray-800 dark:bg-opacity-60 hover:bg-gray-200;
  }
}

.audio-volume {
  @apply flex items-center relative;
  &:hover {
    .volume-slider {
      @apply opacity-100 visible;
    }
  }
  .volume-icon {
    @apply cursor-pointer;
  }

  .iconfont {
    @apply text-2xl transition;
    @apply hover:text-green-500;
  }

  .volume-slider {
    @apply absolute opacity-0 invisible transition-all duration-300 bottom-[30px] left-1/2 -translate-x-1/2 h-[180px] px-2 py-4 rounded-xl;
    @apply bg-light dark:bg-dark-200;
    @apply border border-gray-200 dark:border-gray-700;

    .volume-percentage {
      @apply absolute -top-6 left-1/2 -translate-x-1/2 text-xs font-medium bg-light dark:bg-dark-200 px-2 py-1 rounded-md;
      @apply border border-gray-200 dark:border-gray-700;
      @apply text-gray-800 dark:text-white;
      white-space: nowrap;

      &.volume-percentage-disabled {
        @apply text-gray-400 dark:text-gray-500;
      }
    }
  }
}

.audio-button {
  @apply flex items-center;

  .iconfont {
    @apply text-2xl transition cursor-pointer mx-3;
    @apply hover:text-green-500;
  }
}

.music-play {
  &-list {
    height: 50vh;
    width: 300px;
    @apply relative rounded-3xl overflow-hidden py-2;
    &-back {
      backdrop-filter: blur(20px);
      @apply absolute top-0 left-0 w-full h-full;
      @apply bg-light dark:bg-black bg-opacity-75;
    }
    &-content {
      @apply mx-2;
    }
  }
}

.mobile {
  .music-play-bar {
    @apply px-4 bottom-[56px] transition-all duration-300;
  }
  .music-time {
    display: none;
  }
  .ri-netease-cloud-music-line {
    display: none;
  }
  .audio-volume {
    display: none;
  }
  .audio-button {
    @apply mx-0;
  }
  .music-buttons {
    @apply m-0;
    &-prev,
    &-next {
      display: none;
    }
    &-play {
      @apply m-0;
    }
  }
  .music-content {
    flex: 1;
  }
}

// 自定义滑块样式
.custom-slider {
  :deep(.n-slider) {
    --n-rail-height: 4px;
    --n-rail-color: theme('colors.gray.200');
    --n-rail-color-dark: theme('colors.gray.700');
    --n-fill-color: theme('colors.green.500');
    --n-handle-size: 12px;
    --n-handle-color: theme('colors.green.500');

    &.n-slider--vertical {
      height: 100%;

      .n-slider-rail {
        width: 4px;
      }

      &:hover {
        .n-slider-rail {
          width: 6px;
        }

        .n-slider-handle {
          width: 14px;
          height: 14px;
        }
      }
    }

    .n-slider-rail {
      @apply overflow-hidden transition-all duration-200;
      @apply bg-gray-500 dark:bg-dark-300 bg-opacity-10 !important;
    }

    .n-slider-handle {
      @apply transition-all duration-200;
      opacity: 0;
    }

    &:hover {
      .n-slider-handle {
        opacity: 1;
      }
    }

    // 确保悬停时提示样式正确
    .n-slider-tooltip {
      @apply bg-dark-200 text-white text-xs py-1 px-2 rounded;
      z-index: 999999;
    }
  }
}

.play-bar-img-wrapper {
  @apply relative cursor-pointer w-14 h-14;

  .hover-arrow {
    @apply absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 rounded-2xl;
    background: rgba(0, 0, 0, 0.5);

    .hover-content {
      @apply flex flex-col items-center justify-center;

      i {
        @apply text-white mb-0.5;
      }

      .hover-text {
        @apply text-white text-xs scale-90;
      }
    }
  }

  &:hover {
    .hover-arrow {
      @apply opacity-100;
    }
  }
}

.tooltip-content {
  @apply text-sm py-1 px-2;
}

.play-bar-img {
  @apply w-14 h-14 rounded-2xl;
}

.like-active {
  @apply text-red-500 hover:text-red-600 !important;
}

.intelligence-active {
  @apply text-green-500 hover:text-green-600 !important;
}

.disabled-icon {
  @apply opacity-50 cursor-not-allowed !important;
  &:hover {
    @apply text-inherit !important;
  }
}

.icon-loop,
.icon-single-loop {
  font-size: 1.5rem;
}

.music-time .n-slider {
  position: absolute;
  top: 0;
  left: 0;
  padding: 0;
  border-radius: 0;
}

.music-eq {
  @apply p-4 rounded-3xl;
  backdrop-filter: blur(20px);
  @apply bg-light dark:bg-black bg-opacity-75;
}

.music-play-list-content {
  @apply mx-2;

  .delete-btn {
    @apply p-2 rounded-full transition-colors duration-200 cursor-pointer;
    @apply hover:bg-red-50 dark:hover:bg-red-900/20;

    .iconfont {
      @apply text-lg;
    }
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.loading-overlay {
  @apply absolute inset-0 flex items-center justify-center rounded-2xl;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 2;
}

.loading-icon {
  font-size: 24px;
  color: white;
  animation: spin 1s linear infinite;
}

.play-speed {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0 8px;
}

.speed-button {
  font-size: 14px;
  color: var(--text-color);
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--hover-color);
}

.speed-button:hover {
  background: var(--hover-color-dark);
}

.playback-rate-badge {
  @apply ml-2 px-1.5 h-4 flex items-center text-xs rounded bg-green-500 bg-opacity-15 text-green-600 dark:text-green-400;
  font-weight: 500;
  vertical-align: 1px;
}

// Bit-Perfect 状态徽章（金色小锁 + WASAPI 模式 + 音频规格）
.bp-badge {
  @apply ml-2 px-1.5 h-[18px] flex items-center gap-1 rounded text-[11px] font-medium;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  background: linear-gradient(135deg, rgba(255, 200, 60, 0.18), rgba(255, 165, 0, 0.1));
  border: 1px solid rgba(255, 195, 40, 0.45);
  color: #e8b64c;
}

.bp-badge-lock {
  font-size: 11px;
  line-height: 1;
  color: #f5c518;
  text-shadow: 0 0 4px rgba(245, 197, 24, 0.5);
}

.bp-badge-main {
  font-weight: 600;
}

.bp-badge-specs {
  font-weight: 400;
  opacity: 0.85;
}

.bp-badge-exclusive {
  box-shadow:
    0 0 10px rgba(245, 197, 24, 0.28),
    inset 0 0 6px rgba(245, 197, 24, 0.08);

  .bp-badge-lock {
    animation: bp-lock-glow 2.4s ease-in-out infinite;
  }
}

.bp-badge-shared {
  border-color: rgba(255, 195, 40, 0.28);
  color: #c9a86a;
  background: linear-gradient(135deg, rgba(255, 200, 60, 0.1), rgba(255, 165, 0, 0.05));

  .bp-badge-lock {
    color: #b3924a;
    text-shadow: none;
  }
}

@keyframes bp-lock-glow {
  0%,
  100% {
    text-shadow: 0 0 3px rgba(245, 197, 24, 0.5);
  }
  50% {
    text-shadow: 0 0 9px rgba(245, 197, 24, 0.95);
  }
}

.audio-info-badge {
  @apply ml-2 px-1.5 h-[18px] flex items-center gap-1 rounded text-[11px] font-medium;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  background: rgba(100, 160, 255, 0.12);
  border: 1px solid rgba(100, 160, 255, 0.3);
  color: #6ea8fe;

  i {
    font-size: 11px;
    line-height: 1;
  }
}

.audio-info-specs {
  font-weight: 400;
  opacity: 0.85;
}
</style>
