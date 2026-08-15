<template>
  <div class="local-music-page h-full w-full bg-white dark:bg-black transition-colors duration-500">
    <n-scrollbar class="h-full">
      <div class="local-music-content pb-32">
        <!-- Hero Section -->
        <section class="hero-section relative overflow-hidden rounded-tl-2xl">
          <!-- 背景模糊效果 -->
          <div class="hero-bg absolute inset-0 -top-20">
            <div
              class="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-primary/10 blur-3xl opacity-50 dark:opacity-30"
            ></div>
            <div
              class="absolute inset-0 bg-gradient-to-b from-transparent via-white/80 to-white dark:via-black/80 dark:to-black"
            ></div>
          </div>

          <!-- Hero 内容 -->
          <div class="hero-content relative z-10 page-padding-x pt-6 pb-4">
            <div class="flex items-center gap-5">
              <div
                class="cover-container relative w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center shadow-lg ring-2 ring-white/50 dark:ring-neutral-800/50 shrink-0"
              >
                <i class="ri-folder-music-fill text-4xl text-primary opacity-80" />
              </div>

              <div class="info-content min-w-0">
                <h1
                  class="text-2xl md:text-3xl font-bold text-neutral-900 dark:text-white tracking-tight"
                >
                  {{ t('localMusic.title') }}
                </h1>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {{ t('localMusic.songCount', { count: localMusicStore.musicList.length }) }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- Action Bar (Sticky on scroll) -->
        <section
          class="action-bar sticky top-0 z-20 page-padding-x py-3 md:py-4 bg-white/80 dark:bg-black/80 backdrop-blur-xl border-b border-neutral-100 dark:border-neutral-800/50"
        >
          <div class="flex items-center justify-between gap-4">
            <!-- 左侧：搜索框 -->
            <div class="flex-1 max-w-xs">
              <n-input
                v-model:value="searchKeyword"
                :placeholder="t('localMusic.search')"
                clearable
                size="small"
                round
              >
                <template #prefix>
                  <i class="ri-search-line text-neutral-400" />
                </template>
              </n-input>
            </div>

            <!-- 右侧：操作按钮 -->
            <div class="flex items-center gap-3">
              <!-- 播放全部按钮 -->
              <button
                v-if="filteredList.length > 0"
                class="action-btn-pill flex items-center gap-2 px-4 py-2 rounded-full font-semibold text-sm transition-all bg-primary text-white hover:bg-primary/90"
                @click="handlePlayAll"
              >
                <i class="ri-play-fill text-lg" />
                <span class="hidden md:inline">{{ t('localMusic.playAll') }}</span>
              </button>

              <!-- 扫描按钮（下拉菜单：增量扫描 / 清除重新扫描） -->
              <n-dropdown :options="scanDropdownOptions" @select="handleScanSelect">
                <button
                  class="action-btn-icon w-10 h-10 rounded-full flex items-center justify-center bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-all"
                  :disabled="localMusicStore.scanning"
                >
                  <i
                    class="ri-refresh-line text-lg"
                    :class="{ 'animate-spin': localMusicStore.scanning }"
                  />
                </button>
              </n-dropdown>

              <!-- 添加文件夹按钮 -->
              <button
                class="action-btn-icon w-10 h-10 rounded-full flex items-center justify-center bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-all"
                @click="handleAddFolder"
              >
                <i class="ri-folder-add-line text-lg" />
              </button>

              <!-- 文件夹管理按钮 -->
              <button
                v-if="localMusicStore.folderPaths.length > 0"
                class="action-btn-icon w-10 h-10 rounded-full flex items-center justify-center bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-all"
                @click="showFolderManager = true"
              >
                <i class="ri-folder-settings-line text-lg" />
              </button>
            </div>
          </div>
        </section>

        <!-- 扫描进度提示 -->
        <section v-if="localMusicStore.scanning" class="page-padding-x mt-6">
          <div
            class="flex items-center gap-4 p-4 rounded-2xl bg-primary/5 dark:bg-primary/10 border border-primary/20"
          >
            <n-spin size="small" />
            <div>
              <p class="text-sm font-medium text-neutral-900 dark:text-white">
                {{ t('localMusic.scanning') }}
              </p>
              <p class="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {{ t('localMusic.songCount', { count: localMusicStore.scanProgress }) }}
              </p>
            </div>
          </div>
        </section>

        <!-- 歌曲列表 -->
        <section class="list-section page-padding-x mt-6">
          <!-- 空状态 -->
          <div
            v-if="!localMusicStore.scanning && filteredList.length === 0"
            class="empty-state py-20 text-center"
          >
            <i class="ri-folder-music-fill text-5xl mb-4 text-neutral-200 dark:text-neutral-800" />
            <p class="text-neutral-400">{{ t('localMusic.emptyState') }}</p>
            <button
              class="mt-6 px-6 py-2 rounded-full bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-all"
              @click="handleAddFolder"
            >
              <i class="ri-folder-add-line mr-2" />
              {{ t('localMusic.scanFolder') }}
            </button>
          </div>

          <!-- 歌曲列表（专辑分组：CUE 专辑 / 多曲目专辑显示专辑头，可折叠） -->
          <div v-else-if="filteredList.length > 0" class="song-list-container">
            <template v-for="group in albumGroups" :key="group.key">
              <!-- 专辑分组（有真实专辑名，含单曲专辑）：专辑名 + 播放按钮 + 折叠 -->
              <div
                v-if="!group.isFlat"
                class="album-group"
                :style="cueAccentColor ? { '--album-cue-accent': cueAccentColor } : undefined"
              >
                <div
                  class="album-group-header"
                  :class="{
                    'album-group-header-cue': group.isCueAlbum,
                    'album-group-header-collapsed': isAlbumCollapsed(group.key)
                  }"
                  @click="toggleAlbumCollapse(group.key)"
                >
                  <n-image
                    v-if="group.cover"
                    :src="getImgUrl(group.cover, '80y80')"
                    class="album-group-cover"
                    preview-disabled
                    :img-props="{ crossorigin: 'anonymous' }"
                  />
                  <div v-else class="album-group-cover album-group-cover-fallback">
                    <i class="ri-disc-fill" />
                  </div>
                  <div class="album-group-meta min-w-0 flex-1">
                    <div class="album-group-title truncate">
                      {{ group.album }}
                      <span v-if="group.isCueAlbum" class="cue-tag">CUE</span>
                    </div>
                    <div class="album-group-subtitle truncate">
                      <span>{{ group.artist }}</span>
                      <span v-if="group.artist" class="mx-1 opacity-60">·</span>
                      <span>{{ t('localMusic.songCount', { count: group.items.length }) }}</span>
                    </div>
                  </div>
                  <div class="album-group-actions">
                    <n-tooltip trigger="hover" :z-index="99999">
                      <template #trigger>
                        <button class="album-group-play-btn" @click.stop="handlePlayAlbum(group)">
                          <i class="ri-play-fill" />
                        </button>
                      </template>
                      {{ t('localMusic.playAlbum') }}
                    </n-tooltip>
                    <i
                      class="ri-arrow-down-s-line album-group-chevron"
                      :class="{ 'album-group-chevron-collapsed': isAlbumCollapsed(group.key) }"
                    />
                  </div>
                </div>
                <div v-show="!isAlbumCollapsed(group.key)" class="album-group-songs">
                  <song-item
                    v-for="item in group.items"
                    :key="item.song.id"
                    :index="item.index"
                    :item="item.song"
                    :can-remove="true"
                    :show-album="true"
                    @play="handlePlaySong"
                    @remove-song="handleRemoveSong"
                  />
                </div>
              </div>
              <!-- 单曲（未分组） -->
              <song-item
                v-else
                :key="group.items[0].song.id"
                :index="group.items[0].index"
                :item="group.items[0].song"
                :can-remove="true"
                :show-album="true"
                @play="handlePlaySong"
                @remove-song="handleRemoveSong"
              />
            </template>
          </div>
        </section>
      </div>
    </n-scrollbar>

    <!-- 文件夹管理抽屉 -->
    <n-drawer v-model:show="showFolderManager" :width="400" placement="right">
      <n-drawer-content :title="t('localMusic.removeFolder')" closable>
        <div class="space-y-3 py-4">
          <div
            v-for="folder in localMusicStore.folderPaths"
            :key="folder"
            class="flex items-center justify-between p-3 rounded-xl bg-neutral-50 dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <i class="ri-folder-line text-lg text-primary flex-shrink-0" />
              <span class="text-sm text-neutral-700 dark:text-neutral-300 truncate">{{
                folder
              }}</span>
            </div>
            <button
              class="w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-red-500 hover:bg-red-500/10 transition-all flex-shrink-0 ml-2"
              @click="handleRemoveFolder(folder)"
            >
              <i class="ri-delete-bin-line" />
            </button>
          </div>

          <!-- 空文件夹列表 -->
          <div v-if="localMusicStore.folderPaths.length === 0" class="text-center py-8">
            <i class="ri-folder-line text-4xl text-neutral-200 dark:text-neutral-800" />
            <p class="text-sm text-neutral-400 mt-2">{{ t('localMusic.emptyState') }}</p>
          </div>
        </div>

        <template #footer>
          <n-button type="primary" block @click="handleAddFolder">
            <template #icon>
              <i class="ri-folder-add-line" />
            </template>
            {{ t('localMusic.scanFolder') }}
          </n-button>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { NDropdown, createDiscreteApi } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import SongItem from '@/components/common/SongItem.vue';
import { useLocalMusicStore } from '@/store/modules/localMusic';
import { usePlayerStore } from '@/store/modules/player';
import type { SongResult } from '@/types/music';
import { getImgUrl } from '@/utils';
import { hasCustomLyricThemeColor, loadLyricThemeColor } from '@/utils/linearColor';
import { filterByKeyword, toSongResult } from '@/utils/localMusicUtils';

// ==================== Stores ====================
const { t } = useI18n();
const { message } = createDiscreteApi(['message']);
const localMusicStore = useLocalMusicStore();
const playerStore = usePlayerStore();

// ==================== State ====================
/** 搜索关键词 */
const searchKeyword = ref('');
/** 文件夹管理抽屉是否显示 */
const showFolderManager = ref(false);
/** 已折叠的专辑分组（key → 是否折叠） */
const collapsedAlbums = ref<Record<string, boolean>>({});

/**
 * 专辑头部高亮色：用户自定义了歌词主题色时跟随之（写入 --album-cue-accent）；
 * 未自定义时返回空串，不绑定内联样式，由 CSS 变量默认值决定（亮色金色 #f59e0b / 暗色 #fbbf24）
 */
const cueAccentColor = computed(() => (hasCustomLyricThemeColor() ? loadLyricThemeColor() : ''));

// ==================== Computed ====================
/** 根据搜索关键词过滤后的本地音乐列表 */
const filteredList = computed(() => {
  return filterByKeyword(localMusicStore.musicList, searchKeyword.value);
});

/** 将过滤后的列表转换为 SongResult[] 供 SongItem 使用 */
const filteredSongResults = computed(() => {
  return filteredList.value.map(toSongResult);
});

/**
 * 专辑名规范化：统一大小写与常见分隔符，用于分组 key。
 * 同一专辑在标签中写法可能不同（如"姚璎格.粤•无双" vs "姚璎格.粤·无双"），
 * 规范化后视为同一专辑归入同一组，显示名仍用首见写法。
 */
const normalizeAlbumName = (name: string): string =>
  name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\u00a0\u3000]/g, '')
    .replace(/[·•・．.]+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();

/** 无实际专辑名（应作为单曲平铺展示，不参与专辑分组）——与 normalizeAlbumName 同规格比较 */
const UNKNOWN_ALBUM_NAMES = ['未知专辑', '未知專輯', 'unknown album', '未知', 'unknown'];

interface AlbumGroupItem {
  song: SongResult;
  /** 在整个列表中的序号（专辑内排序后重新编号，保证连续） */
  index: number;
}

interface AlbumGroup {
  key: string;
  album: string;
  artist: string;
  cover: string;
  /** 是否 CUE 专辑（CUE 子轨按 TRACK 编号排序） */
  isCueAlbum: boolean;
  /** 无真实专辑名（平铺单曲，不渲染专辑头） */
  isFlat: boolean;
  items: AlbumGroupItem[];
}

/**
 * 专辑分组：
 *  - CUE 子轨按所在 CUE 文件分组（album 取自 CUE TITLE/文件名）
 *  - 有真实专辑名的歌曲（含单曲专辑）按专辑名分组，渲染专辑头，可折叠/整张播放
 *  - 无专辑名的歌曲保持单曲平铺
 */
const albumGroups = computed<AlbumGroup[]>(() => {
  const results = filteredSongResults.value;
  const groups: AlbumGroup[] = [];
  const byKey = new Map<string, AlbumGroup>();
  let flatIndex = 0;

  for (const song of results) {
    const isCue = !!song.cueIndex;
    let key: string;
    let isFlat = false;
    const albumName = (song.al?.name || '').trim();
    const albumKey = normalizeAlbumName(albumName);
    if (isCue) {
      if (albumKey && !UNKNOWN_ALBUM_NAMES.includes(albumKey)) {
        key = `album:${albumKey}`;
      } else {
        key = `cue:${song.cueFrom || song.id}`;
      }
    } else {
      if (!albumKey || UNKNOWN_ALBUM_NAMES.includes(albumKey)) {
        key = `flat:${song.id}`;
        isFlat = true;
      } else {
        key = `album:${albumKey}`;
      }
    }

    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        album: albumName,
        artist: song.ar?.[0]?.name || '',
        cover: song.picUrl || '',
        isCueAlbum: isCue,
        isFlat,
        items: []
      };
      byKey.set(key, group);
      groups.push(group);
    }
    if (!group.artist && song.ar?.[0]?.name) group.artist = song.ar[0].name;
    if (!group.cover && song.picUrl) group.cover = song.picUrl;
    group.items.push({ song, index: flatIndex });
    flatIndex++;
  }

  // CUE 专辑按 TRACK 编号升序（实现指南 7.3：TRACK 从 1 开始）
  for (const group of groups) {
    if (group.isCueAlbum) {
      group.items.sort((a, b) => (a.song.cueIndex || 0) - (b.song.cueIndex || 0));
    }
  }
  // 排序后重新编号，保证序号连续
  flatIndex = 0;
  for (const group of groups) {
    for (const item of group.items) {
      item.index = flatIndex++;
    }
  }

  return groups;
});

/** 专辑分组是否处于折叠状态 */
const isAlbumCollapsed = (key: string): boolean => !!collapsedAlbums.value[key];

/** 点击专辑名：折叠/展开 */
const toggleAlbumCollapse = (key: string): void => {
  collapsedAlbums.value = {
    ...collapsedAlbums.value,
    [key]: !collapsedAlbums.value[key]
  };
};

// ==================== Methods ====================

/**
 * 选择并添加文件夹
 * 调用系统文件夹选择对话框
 * dialog.showOpenDialog 返回 { canceled: boolean, filePaths: string[] }
 */
async function handleAddFolder(): Promise<void> {
  try {
    const result = await window.electron.ipcRenderer.invoke('select-directory');
    if (result && !result.canceled && result.filePaths?.length > 0) {
      localMusicStore.addFolder(result.filePaths[0]);
      // 添加文件夹后自动触发扫描
      await localMusicStore.scanFolders();
    }
  } catch (error) {
    console.error('选择文件夹失败:', error);
    message.error(String(error));
  }
}

/**
 * 移除文件夹
 * @param folder 要移除的文件夹路径
 */
function handleRemoveFolder(folder: string): void {
  localMusicStore.removeFolder(folder);
}

/**
 * 扫描按钮下拉菜单选项
 */
const scanDropdownOptions = computed(() => [
  { label: t('localMusic.rescan'), key: 'rescan' },
  { label: t('localMusic.clearAndRescan'), key: 'clearAndRescan' }
]);

/**
 * 扫描按钮下拉选择
 */
async function handleScanSelect(key: string): Promise<void> {
  if (localMusicStore.folderPaths.length === 0) {
    await handleAddFolder();
    return;
  }
  if (key === 'clearAndRescan') {
    await localMusicStore.clearAndRescan();
  } else {
    await localMusicStore.scanFolders();
  }
}

/**
 * 播放单曲
 * SongItem 内部已通过 playMusicEvent 调用 playerStore.setPlay 触发播放
 * 此处只需设置播放列表上下文，确保上下一首切换正常
 * @param song SongItem 组件 emit 的 SongResult 对象
 */
async function handlePlaySong(_song: SongResult): Promise<void> {
  try {
    // 设置播放列表上下文，确保上下一首切换正常
    playerStore.setPlayList(filteredSongResults.value);
  } catch (error) {
    console.error('播放本地音乐失败:', error);
  }
}

/**
 * 从本地列表移除单曲（仅软件层面移除，不删除磁盘文件）（#713）
 * @param id SongResult.id，即 LocalMusicEntry.id（hex 字符串）
 */
async function handleRemoveSong(id: number | string): Promise<void> {
  try {
    await localMusicStore.removeEntry(String(id));
    message.success(t('localMusic.removedFromLibrary'));
  } catch (error) {
    console.error('移除本地歌曲失败:', error);
    message.error(String(error));
  }
}

/**
 * 播放整张专辑（顺序播放专辑内全部歌曲）
 * @param group 专辑分组
 */
async function handlePlayAlbum(group: AlbumGroup): Promise<void> {
  const songs = group.items.map((item) => item.song);
  if (songs.length === 0) return;
  try {
    playerStore.setPlayList(songs);
    await playerStore.setPlay(songs[0]);
  } catch (error) {
    console.error('播放专辑失败:', error);
  }
}

/**
 * 播放全部
 * 将完整列表转换为 SongResult[] 后设置为播放列表并从第一首开始播放
 */
async function handlePlayAll(): Promise<void> {
  if (filteredSongResults.value.length === 0) return;

  try {
    const firstSong = filteredSongResults.value[0];
    const entry = filteredList.value[0];

    // 检查第一首歌文件是否存在
    const exists = await window.electron.ipcRenderer.invoke('check-file-exists', entry.filePath);
    if (!exists) {
      message.error(t('localMusic.fileNotFound'));
      return;
    }

    // 设置播放列表并播放第一首
    playerStore.setPlayList(filteredSongResults.value);
    await playerStore.setPlay(firstSong);
  } catch (error) {
    console.error('播放全部失败:', error);
  }
}

// ==================== Lifecycle ====================
onMounted(async () => {
  // 进入页面时从 IndexedDB 缓存加载音乐列表
  await localMusicStore.loadFromCache();
});
</script>

<style scoped>
/* 专辑分组 */
.album-group {
  @apply mb-1 rounded-2xl transition-colors;
}

.album-group-header {
  /* 常驻底色：专辑名一行与下方歌曲行区分（用户要求“专辑名称一行不同背景颜色”） */
  @apply flex items-center gap-3 px-2 py-2 cursor-pointer select-none rounded-xl;
  @apply bg-neutral-100/70 dark:bg-neutral-900/70;
  @apply hover:bg-neutral-200/70 dark:hover:bg-neutral-800/70 transition-colors;
}

/* CUE 专辑头部：高亮色底 + 左侧竖条装饰，与金色 CUE 徽标呼应 */
.album-group-header-cue {
  /* color-mix 让背景色跟随 --album-cue-accent（默认金色/用户自定义主题色） */
  background-color: color-mix(in srgb, var(--album-cue-accent) 10%, transparent);
  box-shadow: inset 3px 0 0 0 var(--album-cue-accent);
  padding-left: calc(0.5rem + 3px);
}

.album-group-header-cue:hover {
  background-color: color-mix(in srgb, var(--album-cue-accent) 18%, transparent);
}

/* 折叠状态：背景更淡，与展开状态区分 */
.album-group-header-collapsed {
  @apply bg-neutral-100/40 dark:bg-neutral-900/40;
}

.album-group-header-cue.album-group-header-collapsed {
  background-color: color-mix(in srgb, var(--album-cue-accent) 5%, transparent);
}

.album-group-header-collapsed:hover {
  @apply bg-neutral-200/50 dark:bg-neutral-800/50;
}

.album-group-header-cue.album-group-header-collapsed:hover {
  background-color: color-mix(in srgb, var(--album-cue-accent) 10%, transparent);
}

.album-group-cover {
  @apply w-10 h-10 rounded-lg flex-shrink-0 overflow-hidden;
}

.album-group-cover :deep(img) {
  @apply w-full h-full object-cover;
}

.album-group-cover-fallback {
  @apply flex items-center justify-center bg-primary/10 text-primary;

  i {
    @apply text-lg;
  }
}

.album-group-meta {
  @apply min-w-0;
}

.album-group-title {
  @apply text-sm font-semibold text-neutral-800 dark:text-neutral-100;
}

.cue-tag {
  @apply ml-1.5 px-1 py-px rounded text-[10px] font-bold align-middle;
  @apply bg-amber-400/15 text-amber-500 border border-amber-400/30;
}

.album-group-subtitle {
  @apply text-xs text-neutral-400 dark:text-neutral-500 mt-0.5;
}

.album-group-actions {
  @apply flex items-center gap-1 flex-shrink-0;
}

.album-group-play-btn {
  @apply w-8 h-8 rounded-full flex items-center justify-center transition-all;
  @apply bg-primary/10 text-primary hover:bg-primary hover:text-white;

  i {
    @apply text-lg;
  }
}

.album-group-chevron {
  @apply text-lg text-neutral-400 dark:text-neutral-500 transition-transform duration-200;
}

.album-group-chevron-collapsed {
  transform: rotate(-90deg);
}

/* 专辑内歌曲缩进 */
.album-group-songs {
  @apply pl-4 md:pl-6;
}

/* 虚拟列表样式 */
.song-virtual-list {
  @apply w-full;
}

.song-virtual-list :deep(.n-virtual-list__scroll) {
  scrollbar-width: thin;
}

.song-virtual-list :deep(.n-virtual-list__scroll)::-webkit-scrollbar {
  width: 6px;
}

.song-virtual-list :deep(.n-virtual-list__scroll)::-webkit-scrollbar-thumb {
  @apply bg-neutral-300 dark:bg-neutral-700 rounded-full;
}

.song-virtual-list :deep(.n-virtual-list__scroll)::-webkit-scrollbar-track {
  @apply bg-transparent;
}
</style>
