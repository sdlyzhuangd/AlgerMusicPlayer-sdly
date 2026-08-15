// 本地音乐 Pinia Store
// 管理本地音乐列表、扫描状态和文件夹配置
// 使用 IndexedDB 缓存音乐元数据，localStorage 持久化文件夹路径

import { createDiscreteApi } from 'naive-ui';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import useIndexedDB from '@/hooks/IndexDBHook';
import type { LocalMusicEntry } from '@/types/localMusic';
import {
  cueFileBaseName,
  dirnameOfPath,
  filterCueCoveredEntries,
  matchSidecarLrcByName,
  removeStaleEntries,
  resolveCueAudioPath
} from '@/utils/localMusicUtils';

const { message } = createDiscreteApi(['message']);

/** IndexedDB store 名称 */
const LOCAL_MUSIC_STORE = 'local_music' as const;

/** IndexedDB 数据类型映射 */
type LocalMusicDBStores = {
  local_music: LocalMusicEntry;
};

/**
 * 使用 filePath 生成唯一 ID
 * 采用简单的字符串 hash 算法，确保同一路径始终生成相同 ID
 * @param filePath 文件绝对路径
 * @returns hash 字符串作为唯一 ID
 */
function generateId(filePath: string): string {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    const char = filePath.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // 转为正数的十六进制字符串
  return (hash >>> 0).toString(16);
}

/**
 * 初始化 IndexedDB 实例
 * 使用 localMusicDB 数据库，包含 local_music 表
 */
async function initLocalMusicDB() {
  return await useIndexedDB<typeof LOCAL_MUSIC_STORE, LocalMusicDBStores>(
    'localMusicDB',
    [{ name: LOCAL_MUSIC_STORE, keyPath: 'id' }],
    1
  );
}

/**
 * 本地音乐管理 Store
 * 负责：文件夹管理、音乐扫描、IndexedDB 缓存、增量更新
 */
export const useLocalMusicStore = defineStore(
  'localMusic',
  () => {
    // ==================== 状态 ====================
    /** 已配置的文件夹路径列表 */
    const folderPaths = ref<string[]>([]);
    /** 本地音乐列表（从 IndexedDB 加载） */
    const musicList = ref<LocalMusicEntry[]>([]);
    /** 是否正在扫描 */
    const scanning = ref(false);
    /** 已扫描文件数（用于显示进度） */
    const scanProgress = ref(0);

    /** IndexedDB 实例（延迟初始化） */
    let db: Awaited<ReturnType<typeof initLocalMusicDB>> | null = null;

    /**
     * 获取 IndexedDB 实例，首次调用时初始化
     */
    async function getDB() {
      if (!db) {
        db = await initLocalMusicDB();
      }
      return db;
    }

    // ==================== 动作 ====================

    /**
     * 添加文件夹路径
     * 如果路径已存在则忽略
     * @param path 文件夹路径
     */
    function addFolder(path: string): void {
      if (!path || folderPaths.value.includes(path)) {
        return;
      }
      folderPaths.value.push(path);
    }

    /**
     * 移除文件夹路径
     * @param path 要移除的文件夹路径
     */
    function removeFolder(path: string): void {
      const index = folderPaths.value.indexOf(path);
      if (index !== -1) {
        folderPaths.value.splice(index, 1);
      }
    }

    /**
     * 扫描所有已配置的文件夹
     * 流程：IPC 扫描文件 → 增量对比 → 解析变更文件元数据 → 存入 IndexedDB → 更新列表
     */
    async function scanFolders(): Promise<void> {
      if (scanning.value || folderPaths.value.length === 0) {
        return;
      }

      scanning.value = true;
      scanProgress.value = 0;

      try {
        const localDB = await getDB();

        // 加载当前缓存数据用于增量对比
        const cachedEntries = await localDB.getAllData(LOCAL_MUSIC_STORE);
        const cachedMap = new Map<string, LocalMusicEntry>();
        for (const entry of cachedEntries) {
          cachedMap.set(entry.filePath, entry);
        }

        // 磁盘上实际存在的文件路径集合（扫描时收集）
        const diskFilePaths = new Set<string>();
        // 本次扫描发现的全部 CUE 分轨文件（各文件夹收集后统一解析）
        const allCueFiles: { path: string; modifiedTime: number }[] = [];
        // 扫描失败的文件夹：其下的缓存条目不参与"已删除清理"，
        // 避免移动盘/网络盘暂时不可用时整个文件夹的歌曲被误删（#713）
        const failedFolders: string[] = [];

        // 遍历每个文件夹进行扫描
        for (const folderPath of folderPaths.value) {
          try {
            // 1. 调用 IPC 扫描文件夹，获取文件路径与修改时间
            const result = await window.api.scanLocalMusicWithStats(folderPath);

            // 检查是否返回错误
            if ((result as any).error) {
              console.error(`扫描文件夹失败: ${folderPath}`, (result as any).error);
              message.error(`扫描失败: ${(result as any).error}`);
              failedFolders.push(folderPath);
              continue;
            }

            const { files } = result;
            scanProgress.value += files.length;

            // 记录磁盘上存在的文件
            for (const file of files) {
              diskFilePaths.add(file.path);
            }

            // 收集该文件夹下的 CUE 分轨文件（统一到扫描末尾解析）
            const cueFiles: { path: string; modifiedTime: number }[] =
              (result as any).cueFiles || [];
            for (const cue of cueFiles) {
              allCueFiles.push(cue);
            }

            // 2. 增量扫描：基于修改时间筛选需重新解析的文件
            // 老条目（无 coverPath 字段）也视为需要重新解析，让数据自愈到统一格式
            const parseTargets: string[] = [];
            for (const file of files) {
              const cached = cachedMap.get(file.path);
              if (
                !cached ||
                cached.modifiedTime !== file.modifiedTime ||
                !('coverPath' in cached)
              ) {
                parseTargets.push(file.path);
              }
            }

            // 3. 仅解析新增或变更文件，避免对未变更文件重复解析元数据
            if (parseTargets.length > 0) {
              const metas = await window.api.parseLocalMusicMetadata(parseTargets);
              for (const meta of metas) {
                const entry: LocalMusicEntry = {
                  ...meta,
                  id: generateId(meta.filePath)
                };
                await localDB.saveData(LOCAL_MUSIC_STORE, entry);
                cachedMap.set(entry.filePath, entry);
              }
            }
          } catch (error) {
            console.error(`扫描文件夹出错: ${folderPath}`, error);
            message.error(`扫描文件夹出错: ${folderPath}`);
            failedFolders.push(folderPath);
          }
        }

        /** 判断文件路径是否位于某个扫描失败的文件夹下 */
        const isUnderFailedFolder = (filePath: string): boolean =>
          failedFolders.some((folder) => {
            if (!filePath.startsWith(folder)) return false;
            if (folder.endsWith('/') || folder.endsWith('\\')) return true;
            const next = filePath.charAt(folder.length);
            return next === '/' || next === '\\';
          });

        // 4. CUE 分轨识别：解析各 CUE 文件，生成子轨条目
        //    整轨/多文件时长推算、封面/音质复用音频文件元数据（实现指南 7.3/7.4）
        const activeCueTrackIds = new Set<string>();
        // 按目录缓存 .lrc 文件名索引（实现指南 7.7），避免每个子轨都去探测一次文件
        // 存完整文件名（含扩展名），交给 matchSidecarLrcByName 做“文件名包含标题”匹配
        const lrcDirIndex = new Map<string, string[]>();
        const getLrcIndex = async (dir: string): Promise<string[]> => {
          let idx = lrcDirIndex.get(dir);
          if (idx) return idx;
          idx = [];
          try {
            const names = await window.api.listLocalDirectory(dir);
            for (const name of names) {
              if (name.toLowerCase().endsWith('.lrc')) idx.push(name);
            }
          } catch (error) {
            console.error(`读取目录失败（旁挂歌词匹配）: ${dir}`, error);
          }
          lrcDirIndex.set(dir, idx);
          return idx;
        };
        // 已缓存条目按 id 索引，用于跳过未变化的子轨重写（降低扫描写放大）
        const cachedById = new Map<string, LocalMusicEntry>();
        for (const cached of cachedEntries) cachedById.set(cached.id, cached);

        for (const cueFile of allCueFiles) {
          let sheet: Awaited<ReturnType<typeof window.api.parseCueSheet>> | null = null;
          try {
            sheet = await window.api.parseCueSheet(cueFile.path);
          } catch (error) {
            console.error(`解析 CUE 失败: ${cueFile.path}`, error);
          }
          if (!sheet || !sheet.tracks || sheet.tracks.length === 0) continue;

          const cueDir = dirnameOfPath(cueFile.path);
          const fallbackAlbum = cueFileBaseName(cueFile.path);

          for (const track of sheet.tracks) {
            const audioPath = resolveCueAudioPath(cueDir, track.audioFile);
            if (!audioPath) continue;
            // 引用音频文件必须真实存在（本次扫描到或已缓存），否则跳过
            if (!diskFilePaths.has(audioPath) && !cachedMap.has(audioPath)) continue;

            // 复用音频文件元数据（封面/音质/时长）；未解析过则现场补解析
            let audioEntry = cachedMap.get(audioPath);
            if (!audioEntry) {
              try {
                const metas = await window.api.parseLocalMusicMetadata([audioPath]);
                if (metas && metas[0]) {
                  audioEntry = { ...metas[0], id: generateId(audioPath) };
                  await localDB.saveData(LOCAL_MUSIC_STORE, audioEntry);
                  cachedMap.set(audioPath, audioEntry);
                }
              } catch (error) {
                console.error(`解析 CUE 引用音频元数据失败: ${audioPath}`, error);
              }
              if (!audioEntry) continue;
            }

            const audioDurationSec = (audioEntry.duration || 0) / 1000;
            // 时长推算：多文件 = 音频文件时长；整轨 = 相邻 INDEX 时间差（末轨用总时长补）
            let durationSec = sheet.isMultiFile ? audioDurationSec : track.duration;
            if (!durationSec) {
              durationSec = Math.max(0, audioDurationSec - track.offset);
            }

            // 歌词：优先音频内嵌，其次同目录旁挂 .lrc（实现指南 7.7，文件名包含标题匹配）
            let lyrics: string | null = audioEntry.lyrics || null;
            if (!lyrics && track.title) {
              const lrcNames = await getLrcIndex(cueDir);
              const matched = matchSidecarLrcByName(lrcNames, track.title);
              if (matched) {
                const lrcPath = resolveCueAudioPath(cueDir, matched);
                try {
                  const sidecar = await window.api.readLocalTextFile(lrcPath);
                  if (sidecar) lyrics = sidecar;
                } catch {
                  /* 旁挂歌词读取失败忽略 */
                }
              }
            }

            const id = generateId(`${audioPath}#cue-${track.index}`);
            const entry: LocalMusicEntry = {
              id,
              filePath: audioPath,
              title: track.title || audioEntry.title,
              artist: track.artist || sheet.albumArtist || audioEntry.artist,
              album: sheet.albumTitle || fallbackAlbum,
              duration: Math.round(durationSec * 1000),
              coverPath: audioEntry.coverPath,
              lyrics,
              fileSize: audioEntry.fileSize,
              modifiedTime: audioEntry.modifiedTime,
              sampleRate: audioEntry.sampleRate,
              bitsPerSample: audioEntry.bitsPerSample,
              cueFrom: audioPath,
              cueIndex: track.index,
              cueOffset: track.offset,
              cueDuration: durationSec
            };
            // 未变化的子轨跳过重写，降低每次扫描的 IndexedDB 写放大
            const prev = cachedById.get(id);
            const changed =
              !prev ||
              prev.title !== entry.title ||
              prev.artist !== entry.artist ||
              prev.album !== entry.album ||
              prev.duration !== entry.duration ||
              prev.cueOffset !== entry.cueOffset ||
              prev.cueDuration !== entry.cueDuration ||
              prev.lyrics !== entry.lyrics;
            if (changed) {
              await localDB.saveData(LOCAL_MUSIC_STORE, entry);
              cachedById.set(id, entry);
            }
            activeCueTrackIds.add(id);
          }
        }

        // 5. 清理已删除文件：从 IndexedDB 移除磁盘上不存在的条目
        // （扫描失败的文件夹跳过清理，其文件未被枚举并不代表已删除）
        for (const [filePath, entry] of cachedMap) {
          if (entry.cueIndex) {
            // CUE 子轨：CUE 文件被删或引用音频文件消失则清理
            const audioPath = entry.cueFrom || filePath;
            const keep = activeCueTrackIds.has(entry.id) && diskFilePaths.has(audioPath);
            if (!keep && !isUnderFailedFolder(audioPath)) {
              await localDB.deleteData(LOCAL_MUSIC_STORE, entry.id);
            }
            continue;
          }
          if (!diskFilePaths.has(filePath) && !isUnderFailedFolder(filePath)) {
            await localDB.deleteData(LOCAL_MUSIC_STORE, entry.id);
          }
        }

        // 6. 从 IndexedDB 重新加载完整列表（过滤被 CUE 覆盖的独立音频文件）
        musicList.value = filterCueCoveredEntries(await localDB.getAllData(LOCAL_MUSIC_STORE));
      } catch (error) {
        console.error('扫描本地音乐失败:', error);
        message.error('扫描本地音乐失败');
      } finally {
        scanning.value = false;
      }
    }

    /**
     * 从 IndexedDB 缓存加载音乐列表
     * 应用启动时或进入本地音乐页面时调用
     */
    async function loadFromCache(): Promise<void> {
      try {
        const localDB = await getDB();
        musicList.value = filterCueCoveredEntries(await localDB.getAllData(LOCAL_MUSIC_STORE));
      } catch (error) {
        console.error('从缓存加载本地音乐失败:', error);
        // 降级：缓存加载失败时保持空列表，用户可手动触发扫描
        musicList.value = [];
      }
    }

    /**
     * 从本地列表移除单个条目（仅软件层面移除，不删除磁盘文件）（#713）
     * @param id 条目 ID（generateId 生成的 hex 字符串）
     */
    async function removeEntry(id: string): Promise<void> {
      const localDB = await getDB();
      await localDB.deleteData(LOCAL_MUSIC_STORE, id);
      const index = musicList.value.findIndex((entry) => entry.id === id);
      if (index !== -1) {
        musicList.value.splice(index, 1);
      }
    }

    /**
     * 清理缓存：检查文件存在性，移除已不存在的文件条目
     */
    async function clearCache(): Promise<void> {
      try {
        const localDB = await getDB();
        const allEntries = await localDB.getAllData(LOCAL_MUSIC_STORE);

        if (allEntries.length === 0) {
          return;
        }

        // 构建文件存在性映射
        const existsMap: Record<string, boolean> = {};
        for (const entry of allEntries) {
          try {
            // 使用已有的 IPC 通道检查文件是否存在
            const exists = await window.electron.ipcRenderer.invoke(
              'check-file-exists',
              entry.filePath
            );
            existsMap[entry.filePath] = exists !== false;
          } catch {
            // 检查失败时假设文件存在，避免误删
            existsMap[entry.filePath] = true;
          }
        }

        // 使用工具函数过滤出仍然存在的条目
        const validEntries = removeStaleEntries(allEntries, existsMap);
        const removedEntries = allEntries.filter(
          (entry) => !validEntries.some((v) => v.id === entry.id)
        );

        // 从 IndexedDB 中删除不存在的条目
        for (const entry of removedEntries) {
          await localDB.deleteData(LOCAL_MUSIC_STORE, entry.id);
        }

        // 更新内存中的列表（过滤被 CUE 覆盖的独立音频文件）
        musicList.value = filterCueCoveredEntries(validEntries);
      } catch (error) {
        console.error('清理缓存失败:', error);
      }
    }

    /**
     * 清除全部缓存并重新扫描
     * 清空 IndexedDB 后重新扫描所有文件夹，效果等同"全新扫描"
     */
    async function clearAndRescan(): Promise<void> {
      if (scanning.value) return;
      try {
        const localDB = await getDB();
        await localDB.clearData(LOCAL_MUSIC_STORE);
        musicList.value = [];
      } catch (error) {
        console.error('清除本地音乐缓存失败:', error);
      }
      await scanFolders();
    }

    return {
      // 状态
      folderPaths,
      musicList,
      scanning,
      scanProgress,

      // 动作
      addFolder,
      removeFolder,
      scanFolders,
      loadFromCache,
      removeEntry,
      clearCache,
      clearAndRescan
    };
  },
  {
    // 持久化配置：仅持久化文件夹路径到 localStorage
    // 音乐列表存储在 IndexedDB 中，不需要 localStorage 持久化
    persist: {
      key: 'local-music-store',
      storage: localStorage,
      pick: ['folderPaths']
    }
  }
);
