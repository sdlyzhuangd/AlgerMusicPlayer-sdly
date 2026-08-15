// 本地音乐工具函数
// 提供格式过滤、元数据 fallback、类型转换、搜索过滤、增量扫描等功能

import type { LocalMusicEntry, LocalMusicMeta } from '@/types/localMusic';
import { SUPPORTED_AUDIO_FORMATS } from '@/types/localMusic';
import type { ILyric, ILyricText, IWordData, SongResult } from '@/types/music';
import { parseLyrics as parseYrcLyrics } from '@/utils/yrcParser';

import { filePathToLocalUrl } from '../../shared/localUrl';

export { filePathToLocalUrl };

/**
 * 判断文件路径是否为支持的音频格式
 * 通过提取文件扩展名（不区分大小写）与支持格式列表比对
 * @param filePath 文件路径
 * @returns 是否为支持的音频格式
 */
export function isSupportedAudioFormat(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(ext);
}

/**
 * 从文件路径中提取歌曲标题（去除目录和扩展名）
 * @param filePath 文件路径
 * @returns 歌曲标题
 */
export function extractTitleFromFilename(filePath: string): string {
  // 兼容 Windows 和 Unix 路径分隔符
  const separator = filePath.includes('\\') ? '\\' : '/';
  const filename = filePath.split(separator).pop() || filePath;
  // 去除扩展名
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex > 0) {
    return filename.slice(0, dotIndex);
  }
  return filename;
}

/**
 * 构建缺失元数据时的 fallback 元数据对象
 * 使用文件名作为标题，"未知艺术家"和"未知专辑"作为默认值
 * @param filePath 文件路径
 * @returns 默认的 LocalMusicMeta 对象
 */
export function buildFallbackMeta(filePath: string): LocalMusicMeta {
  return {
    filePath,
    title: extractTitleFromFilename(filePath),
    artist: '未知艺术家',
    album: '未知专辑',
    duration: 0,
    coverPath: null,
    lyrics: null,
    fileSize: 0,
    modifiedTime: 0,
    sampleRate: 0,
    bitsPerSample: 0
  };
}

/**
 * 将 LRC 格式歌词字符串解析为 ILyric 对象
 * 复用 yrcParser 解析能力，兼容标准 LRC 和 YRC 格式
 * @param lrcString LRC 格式歌词文本
 * @returns ILyric 对象，解析失败返回 null
 */
export function parseLrcToILyric(lrcString: string | null): ILyric | null {
  if (!lrcString || typeof lrcString !== 'string') {
    return null;
  }

  try {
    const parseResult = parseYrcLyrics(lrcString);
    if (!parseResult.success) {
      return null;
    }

    const { lyrics: parsedLyrics } = parseResult.data;
    const lrcArray: ILyricText[] = [];
    const lrcTimeArray: number[] = [];
    let hasWordByWord = false;

    for (const line of parsedLyrics) {
      const hasWords = line.words && line.words.length > 0;
      if (hasWords) hasWordByWord = true;

      lrcArray.push({
        text: line.fullText,
        trText: '',
        words: hasWords ? (line.words as IWordData[]) : undefined,
        hasWordByWord: hasWords,
        startTime: line.startTime,
        duration: line.duration
      });

      lrcTimeArray.push(line.startTime / 1000);
    }

    if (lrcArray.length === 0) {
      return null;
    }

    return { lrcTimeArray, lrcArray, hasWordByWord };
  } catch {
    return null;
  }
}

/**
 * 将 LocalMusicEntry 转换为 SongResult，以复用现有播放系统
 * @param entry 本地音乐条目
 * @returns 兼容播放系统的 SongResult 对象
 */
export function toSongResult(entry: LocalMusicEntry): SongResult {
  // 解析内嵌歌词为 ILyric 对象
  const lyric = parseLrcToILyric(entry.lyrics);

  // 封面统一走落盘文件 + local:// 协议；缺 coverPath 时给空串，
  // SongItem 模板用 v-if="item.picUrl" 自动跳过渲染。
  // 用户重新扫描会让主进程落盘新封面（参见 scanFolders 的自愈条件）
  const coverUrl = entry.coverPath ? filePathToLocalUrl(entry.coverPath) : '';

  return {
    id: entry.id,
    name: entry.title,
    picUrl: coverUrl,
    ar: [
      {
        name: entry.artist,
        id: 0,
        picId: 0,
        img1v1Id: 0,
        briefDesc: '',
        picUrl: '',
        img1v1Url: '',
        albumSize: 0,
        alias: [],
        trans: '',
        musicSize: 0,
        topicPerson: 0
      }
    ],
    al: {
      name: entry.album,
      id: 0,
      type: '',
      size: 0,
      picId: 0,
      blurPicUrl: '',
      companyId: 0,
      pic: 0,
      picUrl: coverUrl,
      publishTime: 0,
      description: '',
      tags: '',
      company: '',
      briefDesc: '',
      artist: {
        name: entry.artist,
        id: 0,
        picId: 0,
        img1v1Id: 0,
        briefDesc: '',
        picUrl: '',
        img1v1Url: '',
        albumSize: 0,
        alias: [],
        trans: '',
        musicSize: 0,
        topicPerson: 0
      },
      songs: [],
      alias: [],
      status: 0,
      copyrightId: 0,
      commentThreadId: '',
      artists: [],
      subType: '',
      transName: null,
      onSale: false,
      mark: 0,
      picId_str: ''
    },
    song: {
      artists: [{ name: entry.artist }],
      album: { name: entry.album }
    },
    playMusicUrl: filePathToLocalUrl(entry.filePath),
    duration: entry.duration,
    dt: entry.duration,
    source: 'netease' as const,
    count: 0,
    // 本地文件音质信息：BP 状态徽章与播放分流使用（无损/未压缩格式有效）
    sampleRate: entry.sampleRate,
    bitsPerSample: entry.bitsPerSample,
    // CUE 子轨信息：播放时 seek 到 cueOffset、在 cueOffset+cueDuration 处切歌
    cueFrom: entry.cueFrom,
    cueIndex: entry.cueIndex,
    cueOffset: entry.cueOffset,
    cueDuration: entry.cueDuration,
    // 内嵌歌词（如果有）
    lyric: lyric ?? undefined,
    // 本地音乐 URL 不会过期，设置一个极大的过期时间
    createdAt: Date.now(),
    expiredAt: Date.now() + 365 * 24 * 60 * 60 * 1000
  };
}

/**
 * 按关键词搜索过滤本地音乐列表
 * 不区分大小写，匹配歌曲标题或艺术家名称
 * 空关键词返回完整列表
 * @param list 本地音乐列表
 * @param keyword 搜索关键词
 * @returns 过滤后的音乐列表
 */
export function filterByKeyword(list: LocalMusicEntry[], keyword: string): LocalMusicEntry[] {
  if (!keyword || keyword.trim() === '') {
    return list;
  }
  const lowerKeyword = keyword.toLowerCase();
  return list.filter((entry) => {
    return (
      entry.title.toLowerCase().includes(lowerKeyword) ||
      entry.artist.toLowerCase().includes(lowerKeyword) ||
      entry.album.toLowerCase().includes(lowerKeyword)
    );
  });
}

// ==================== CUE 分轨路径/可见性工具 ====================

/** 取路径所在目录（兼容 / 与 \ 分隔符） */
export function dirnameOfPath(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : '';
}

/**
 * 解析 CUE 引用的音频文件为绝对路径
 * 绝对路径原样返回；相对路径基于 CUE 文件所在目录拼接
 * @param cueDir CUE 文件所在目录
 * @param audioFile FILE 行声明的文件名
 * @returns 绝对路径，空输入返回 ''
 */
export function resolveCueAudioPath(cueDir: string, audioFile: string): string {
  const f = (audioFile || '').trim();
  if (!f) return '';
  if (/^[a-zA-Z]:[\\/]/.test(f) || f.startsWith('/') || f.startsWith('\\')) return f;
  const sep = cueDir.includes('\\') ? '\\' : '/';
  return cueDir ? `${cueDir}${sep}${f.replace(/[\\/]/g, sep)}` : f;
}

/**
 * 在目录文件列表中按“文件名包含标题”匹配旁挂 .lrc 歌词
 * 精确同名（去扩展名、不区分大小写）优先；否则取包含标题的最短文件名，
 * 避免“xxx合集.lrc”这类泛化文件名误命中。
 * 包含匹配要求标题至少 2 个字符，防止“爱/梦”这类单字标题误伤大量文件。
 * @param names 目录下的文件名列表（含扩展名）
 * @param title 歌曲标题
 * @returns 匹配到的文件名（含 .lrc 扩展名），无匹配返回 null
 */
export function matchSidecarLrcByName(names: string[], title: string): string | null {
  const t = (title || '').trim().toLowerCase();
  if (!t) return null;
  const lrcNames = names.filter((n) => n.toLowerCase().endsWith('.lrc'));
  if (lrcNames.length === 0) return null;
  // 1. 精确同名优先（去扩展名后相等）
  const exact = lrcNames.find((n) => n.slice(0, -4).toLowerCase() === t);
  if (exact) return exact;
  // 2. 包含匹配：取包含标题的最短文件名（同长时按字典序，保证选择确定性）
  const containing = lrcNames
    .filter((n) => n.slice(0, -4).toLowerCase().includes(t) && t.length >= 2)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return containing.length > 0 ? containing[0] : null;
}

/**
 * 播放时兜底：在音频文件所在目录查找旁挂 .lrc 歌词（文件名包含标题）
 * 列表出目录后用 matchSidecarLrcByName 匹配，返回完整路径
 * @param filePath 音频文件绝对路径
 * @param title 歌曲标题
 * @returns 匹配到的 .lrc 文件完整路径，未找到或读取失败返回 null
 */
export async function findSidecarLyricPath(
  filePath: string,
  title: string
): Promise<string | null> {
  const dir = dirnameOfPath(filePath);
  if (!dir) return null;
  try {
    const names = await window.api.listLocalDirectory(dir);
    const matched = matchSidecarLrcByName(names, title);
    if (!matched) return null;
    return resolveCueAudioPath(dir, matched);
  } catch (error) {
    console.error(`查找旁挂歌词失败: ${filePath}`, error);
    return null;
  }
}

/** CUE 文件名（去扩展名），CUE 无专辑标题时用作专辑名兜底 */
export function cueFileBaseName(cueFilePath: string): string {
  const sep = cueFilePath.includes('\\') ? '\\' : '/';
  const base = cueFilePath.split(sep).pop() || cueFilePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 可见性过滤：被 CUE 引用的音频文件不单独展示（实现指南 7.6 去重）
 * 音频文件本身仍保留在 IndexedDB 中，作为 CUE 子轨的封面/音质元数据来源
 * @param entries 全部缓存条目
 * @returns 应展示的条目（去掉被 CUE 覆盖的独立音频文件）
 */
export function filterCueCoveredEntries(entries: LocalMusicEntry[]): LocalMusicEntry[] {
  const covered = new Set(
    entries.filter((e) => e.cueIndex && e.cueFrom).map((e) => e.cueFrom as string)
  );
  if (covered.size === 0) return entries;
  return entries.filter((e) => (e.cueIndex ? true : !covered.has(e.filePath)));
}

/**
 * 增量扫描对比：找出新增或修改时间变更的文件
 * 对比扫描到的文件列表与缓存条目，返回需要重新解析的文件路径
 * @param files 扫描到的文件列表（包含路径和修改时间）
 * @param cached 已缓存的本地音乐条目
 * @returns 需要重新解析的文件路径列表
 */
export function getChangedFiles(
  files: { path: string; modifiedTime: number }[],
  cached: LocalMusicEntry[]
): string[] {
  // 构建缓存映射：filePath -> modifiedTime
  const cachedMap = new Map<string, number>();
  for (const entry of cached) {
    cachedMap.set(entry.filePath, entry.modifiedTime);
  }

  return files
    .filter((file) => {
      const cachedTime = cachedMap.get(file.path);
      // 缓存中不存在（新文件）或修改时间不匹配（已变更）
      return cachedTime === undefined || cachedTime !== file.modifiedTime;
    })
    .map((file) => file.path);
}

/**
 * 缓存清理：移除文件已不存在的条目
 * @param entries 缓存的本地音乐条目列表
 * @param existsMap 文件存在性映射（filePath -> 是否存在）
 * @returns 清理后的条目列表（仅保留文件仍存在的条目）
 */
export function removeStaleEntries(
  entries: LocalMusicEntry[],
  existsMap: Record<string, boolean>
): LocalMusicEntry[] {
  return entries.filter((entry) => existsMap[entry.filePath] === true);
}
