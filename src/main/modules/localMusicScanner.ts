// 本地音乐扫描模块
// 负责文件系统递归扫描和音乐文件元数据提取，通过 IPC 暴露给渲染进程

import * as crypto from 'crypto';
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as mm from 'music-metadata';
import * as os from 'os';
import * as path from 'path';

import { parseCueSheet } from '../../shared/cueSheet';

/** 支持的音频文件格式 */
const SUPPORTED_AUDIO_FORMATS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'] as const;

/** CUE 分轨文件扩展名 */
const CUE_EXTENSION = '.cue';

/**
 * CUE 文本编码自动检测（参照实现指南 7.2）
 * 支持 UTF-8 / UTF-8 BOM / UTF-16 LE/BE BOM，UTF-8 严格解码失败时回退 GB18030（中文 CUE 常见编码）
 */
function decodeTextBuffer(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE：逐字节交换后按 utf16le 解码
    const body = buf.subarray(2);
    const swapped = Buffer.alloc(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return swapped.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

/** 读取文本文件（自动检测编码），失败返回 null */
async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.promises.readFile(filePath);
    return decodeTextBuffer(buf);
  } catch (error) {
    console.error(`读取文本文件失败: ${filePath}`, error);
    return null;
  }
}
const METADATA_PARSE_CONCURRENCY = Math.min(8, Math.max(2, os.cpus().length));
const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** 封面缓存目录：userData/AudioCovers/<hash>.<ext> */
const COVER_DIR_NAME = 'AudioCovers';
let cachedCoverDir: string | null = null;

function getCoverDir(): string {
  if (cachedCoverDir) return cachedCoverDir;
  const dir = path.join(app.getPath('userData'), COVER_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error('创建封面目录失败:', error);
  }
  cachedCoverDir = dir;
  return dir;
}

/** 从 mime 类型推断文件扩展名 */
function extFromMime(mime: string | undefined): string {
  const sub = mime?.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!sub) return 'bin';
  return sub === 'jpeg' ? 'jpg' : sub;
}

/** 旁挂封面文件名（不含扩展名），按优先级排列 */
const COVER_FILENAMES = ['cover', 'folder', 'album', 'front', 'art'] as const;
/** 旁挂封面扩展名 */
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'] as const;

/**
 * 在音频文件所在目录查找旁挂封面图片
 * 优先匹配 cover.jpg/png 等常见文件名，未找到则取目录下第一张图片
 * @param audioFilePath 音频文件绝对路径
 * @returns 封面文件绝对路径，未找到返回 null
 */
async function findSidecarCover(audioFilePath: string): Promise<string | null> {
  const dir = path.dirname(audioFilePath);
  try {
    const entries = await fs.promises.readdir(dir);
    for (const name of COVER_FILENAMES) {
      for (const ext of COVER_EXTENSIONS) {
        const candidate = entries.find((e) => e.toLowerCase() === name + ext);
        if (candidate) return path.join(dir, candidate);
      }
    }
    const imgExtSet = new Set<string>(COVER_EXTENSIONS);
    const imgFile = entries.find((e) => imgExtSet.has(path.extname(e).toLowerCase()));
    if (imgFile) return path.join(dir, imgFile);
  } catch { /* ignore */ }
  return null;
}

/**
 * 将旁挂封面图片文件复制到封面缓存目录，返回缓存路径
 * @param coverPath 旁挂封面图片源文件绝对路径
 * @param audioFilePath 音频文件绝对路径，用于生成稳定的缓存文件名
 * @returns 缓存后的封面文件绝对路径，失败返回 null
 */
async function cacheSidecarCover(coverPath: string, audioFilePath: string): Promise<string | null> {
  try {
    const ext = path.extname(coverPath).toLowerCase().replace('.jpeg', '.jpg') || '.jpg';
    const hash = crypto.createHash('sha256').update(audioFilePath).digest('hex');
    const cached = path.join(getCoverDir(), `${hash}${ext}`);
    await fs.promises.copyFile(coverPath, cached);
    return cached;
  } catch (error) {
    console.error('缓存旁挂封面失败:', error);
    return null;
  }
}

/**
 * 主进程返回的原始音乐元数据
 * 与渲染进程 LocalMusicMeta 类型保持一致
 */
type LocalMusicMeta = {
  /** 文件绝对路径 */
  filePath: string;
  /** 歌曲标题 */
  title: string;
  /** 艺术家名称 */
  artist: string;
  /** 专辑名称 */
  album: string;
  /** 时长（毫秒） */
  duration: number;
  /** 封面图片缓存文件绝对路径，无封面时为 null */
  coverPath: string | null;
  /** LRC 格式歌词文本，无歌词时为 null */
  lyrics: string | null;
  /** 文件大小（字节） */
  fileSize: number;
  /** 文件修改时间戳 */
  modifiedTime: number;
  /** 采样率（Hz），解析失败时为 0 */
  sampleRate: number;
  /** 位深度（bit），无损/未压缩格式有效，解析失败时为 0 */
  bitsPerSample: number;
};

type ScannedMusicFile = {
  path: string;
  modifiedTime: number;
};

type ScannedCueFile = ScannedMusicFile;

type ScanStatsResult = {
  files: ScannedMusicFile[];
  cueFiles: ScannedCueFile[];
};

/**
 * 判断文件扩展名是否为支持的音频格式
 * @param ext 文件扩展名（含点号，如 .mp3）
 * @returns 是否为支持的格式
 */
function isSupportedFormat(ext: string): boolean {
  return (SUPPORTED_AUDIO_FORMATS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * 从文件路径中提取歌曲标题（去除目录和扩展名）
 * @param filePath 文件路径
 * @returns 歌曲标题
 */
function extractTitleFromFilename(filePath: string): string {
  const basename = path.basename(filePath);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex > 0) {
    return basename.slice(0, dotIndex);
  }
  return basename;
}

/**
 * 将封面图片落盘到 userData/AudioCovers/，返回绝对路径
 * 文件名按 sourceFilePath 的 sha256 + 推断扩展名拼成，幂等可覆盖
 * @param picture music-metadata 解析出的封面图片对象
 * @param sourceFilePath 音乐源文件绝对路径，用于生成稳定的封面文件名
 * @returns 封面文件绝对路径，无封面或写入失败返回 null
 */
async function extractCoverToFile(
  picture: mm.IPicture | undefined,
  sourceFilePath: string
): Promise<string | null> {
  if (!picture) {
    return null;
  }
  try {
    if (picture.data.length > MAX_COVER_BYTES) {
      console.warn(
        `封面超过大小上限被跳过: ${sourceFilePath} (${picture.data.length} bytes > ${MAX_COVER_BYTES})`
      );
      return null;
    }
    const ext = extFromMime(picture.format);
    const hash = crypto.createHash('sha256').update(sourceFilePath).digest('hex');
    const coverFile = path.join(getCoverDir(), `${hash}.${ext}`);

    // 直接覆盖写：本函数只在文件 mtime 变更时被调用（见 scanFolders 的 parseTargets），
    // 频率本就受守门；按 size 跳过会在"用户替换内嵌封面、新旧字节数恰好相等"时留旧图，
    // 单张封面几十~几百 KB，覆盖代价可忽略。
    await fs.promises.writeFile(coverFile, Buffer.from(picture.data));
    return coverFile;
  } catch (error) {
    console.error('封面落盘失败:', error);
    return null;
  }
}

/**
 * 将毫秒时间戳格式化为标准 LRC 时间 [mm:ss.xx]
 * @param ms 毫秒时间戳
 * @returns mm:ss.xx 格式字符串
 */
function formatLrcTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const centi = Math.floor((ms % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(centi).padStart(2, '0')}`;
}

/**
 * 从 music-metadata 解析结果中提取歌词文本
 *
 * 优先使用带时间戳的 syncText 重建标准 LRC 文本：
 * 部分 FLAC 的内嵌 LYRICS 注释同时含 text（纯文本，无时间戳）与 syncText（完整带时间戳歌词），
 * 若只取 text 会丢失全部时间戳，播放时被当作无时间戳歌词，无法自动滚动（"本歌词不支持自动滚动"）。
 * 无 syncText 时退回纯文本（MP3 USLT 等），由渲染层按无时间戳歌词处理。
 *
 * @param lyrics music-metadata 解析出的歌词数组
 * @returns LRC 格式歌词文本，提取失败返回 null
 */
function extractLyrics(lyrics: mm.ILyricsTag[] | undefined): string | null {
  if (!lyrics || lyrics.length === 0) {
    return null;
  }
  try {
    // 1. 优先带时间戳的歌词：用 syncText 重建标准 LRC [mm:ss.xx] 文本
    const timed = lyrics.find((l) => l.syncText && l.syncText.length > 0);
    if (timed && timed.syncText) {
      return timed.syncText
        .map(({ timestamp, text }) =>
          typeof timestamp === 'number' ? `[${formatLrcTimestamp(timestamp)}]${text}` : ''
        )
        .filter(Boolean)
        .join('\n');
    }
    // 2. 无时间戳时退回第一条歌词的纯文本
    return lyrics[0]?.text ?? null;
  } catch (error) {
    console.error('歌词提取失败:', error);
    return null;
  }
}

/**
 * 递归扫描指定文件夹，返回所有支持格式的音乐文件路径
 * @param folderPath 要扫描的文件夹路径
 * @returns 音乐文件绝对路径列表
 */
async function scanMusicFiles(folderPath: string): Promise<string[]> {
  const results: string[] = [];

  // 检查文件夹是否存在
  if (!fs.existsSync(folderPath)) {
    throw new Error(`文件夹不存在: ${folderPath}`);
  }

  // 检查是否为目录
  const stat = await fs.promises.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件夹: ${folderPath}`);
  }

  /**
   * 递归遍历目录
   * @param dirPath 当前目录路径
   */
  async function walkDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          await walkDirectory(fullPath);
        } else if (entry.isFile()) {
          // 检查文件扩展名是否为支持的音频格式
          const ext = path.extname(entry.name);
          if (isSupportedFormat(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (error) {
      // 单个目录读取失败不中断整体扫描，记录错误后继续
      console.error(`扫描目录失败: ${dirPath}`, error);
    }
  }

  await walkDirectory(folderPath);
  return results;
}

/**
 * 递归扫描指定文件夹，返回包含修改时间的音乐文件信息
 * @param folderPath 要扫描的文件夹路径
 * @returns 音乐文件信息列表
 */
async function scanMusicFilesWithStats(folderPath: string): Promise<ScanStatsResult> {
  const results: ScannedMusicFile[] = [];
  const cueFiles: ScannedCueFile[] = [];

  if (!fs.existsSync(folderPath)) {
    throw new Error(`文件夹不存在: ${folderPath}`);
  }

  const stat = await fs.promises.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件夹: ${folderPath}`);
  }

  async function walkDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await walkDirectory(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          // 非音频/非 CUE 文件不 stat，避免大目录扫描的额外系统调用
          if (!isSupportedFormat(ext) && ext !== CUE_EXTENSION) {
            continue;
          }

          try {
            const fileStat = await fs.promises.stat(fullPath);
            const item = { path: fullPath, modifiedTime: fileStat.mtimeMs };
            if (isSupportedFormat(ext)) {
              results.push(item);
            } else {
              cueFiles.push(item);
            }
          } catch (error) {
            console.error(`读取文件信息失败: ${fullPath}`, error);
          }
        }
      }
    } catch (error) {
      console.error(`扫描目录失败: ${dirPath}`, error);
    }
  }

  await walkDirectory(folderPath);
  return { files: results, cueFiles };
}

/**
 * 解析单个音乐文件的元数据
 * 解析失败时使用 fallback 默认值（文件名作标题），不抛出异常
 * @param filePath 音乐文件绝对路径
 * @returns 音乐元数据对象
 */
async function parseMetadata(filePath: string): Promise<LocalMusicMeta> {
  // 获取文件信息（大小和修改时间）
  let fileSize = 0;
  let modifiedTime = 0;
  try {
    const stat = await fs.promises.stat(filePath);
    fileSize = stat.size;
    modifiedTime = stat.mtimeMs;
  } catch (error) {
    console.error(`获取文件信息失败: ${filePath}`, error);
  }

  // 构建 fallback 默认值
  const fallback: LocalMusicMeta = {
    filePath,
    title: extractTitleFromFilename(filePath),
    artist: '未知艺术家',
    album: '未知专辑',
    duration: 0,
    coverPath: null,
    lyrics: null,
    fileSize,
    modifiedTime,
    sampleRate: 0,
    bitsPerSample: 0
  };

  try {
    const metadata = await mm.parseFile(filePath);
    const { common, format } = metadata;

    let coverPath = await extractCoverToFile(common.picture?.[0], filePath);
    if (!coverPath) {
      const sidecar = await findSidecarCover(filePath);
      if (sidecar) coverPath = await cacheSidecarCover(sidecar, filePath);
    }

    return {
      filePath,
      title: common.title || fallback.title,
      artist: common.artist || fallback.artist,
      album: common.album || fallback.album,
      duration: format.duration ? Math.round(format.duration * 1000) : 0,
      coverPath,
      lyrics: extractLyrics(common.lyrics),
      fileSize,
      modifiedTime,
      // music-metadata 的 format 中：sampleRate = 采样率；bitsPerSample = 位深度
      // （FLAC/WAV/PCM 等无损格式有值，MP3/AAC 等有损格式通常为 0）
      sampleRate: typeof format.sampleRate === 'number' ? format.sampleRate : 0,
      bitsPerSample: typeof format.bitsPerSample === 'number' ? format.bitsPerSample : 0
    };
  } catch (error) {
    // 解析失败使用 fallback，不中断流程
    console.error(`元数据解析失败，使用 fallback: ${filePath}`, error);
    return fallback;
  }
}

/**
 * 批量解析音乐文件元数据
 * 内部逐个调用 parseMetadata，单文件失败不影响其他文件
 * @param filePaths 音乐文件路径列表
 * @returns 元数据对象列表
 */
async function batchParseMetadata(filePaths: string[]): Promise<LocalMusicMeta[]> {
  if (filePaths.length === 0) {
    return [];
  }

  const results = new Array<LocalMusicMeta>(filePaths.length);
  const workerCount = Math.min(METADATA_PARSE_CONCURRENCY, filePaths.length);
  let index = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (index < filePaths.length) {
      const current = index;
      index += 1;
      results[current] = await parseMetadata(filePaths[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * 初始化本地音乐扫描模块
 * 注册 IPC handler，供渲染进程调用
 */
export function initializeLocalMusicScanner(): void {
  // 扫描指定文件夹中的音乐文件
  ipcMain.handle('scan-local-music', async (_, folderPath: string) => {
    try {
      const files = await scanMusicFiles(folderPath);
      return { files, count: files.length };
    } catch (error: any) {
      console.error('扫描本地音乐失败:', error);
      return { error: error.message || '扫描失败' };
    }
  });

  // 扫描指定文件夹中的音乐文件（包含修改时间）与 CUE 分轨文件
  ipcMain.handle('scan-local-music-with-stats', async (_, folderPath: string) => {
    try {
      const { files, cueFiles } = await scanMusicFilesWithStats(folderPath);
      return { files, cueFiles, count: files.length };
    } catch (error: any) {
      console.error('扫描本地音乐(含文件信息)失败:', error);
      return { error: error.message || '扫描失败' };
    }
  });

  // 批量解析音乐文件元数据
  ipcMain.handle('parse-local-music-metadata', async (_, filePaths: string[]) => {
    try {
      const metadataList = await batchParseMetadata(filePaths);
      return metadataList;
    } catch (error: any) {
      console.error('解析本地音乐元数据失败:', error);
      return [];
    }
  });

  // 读取任意文本文件（自动检测编码），供渲染层解析 CUE 与旁挂 .lrc 歌词
  ipcMain.handle('read-local-text-file', async (_, filePath: string) => {
    return await readTextFile(filePath);
  });

  // 列出目录下的文件名（供旁挂 .lrc 歌词匹配建立索引）
  ipcMain.handle('list-local-directory', async (_, dirPath: string) => {
    try {
      return await fs.promises.readdir(dirPath);
    } catch (error) {
      console.error(`读取目录失败: ${dirPath}`, error);
      return [];
    }
  });

  // 解析 CUE 分轨表：读取文件（编码检测）→ 纯逻辑解析 → 返回原始轨信息
  ipcMain.handle('parse-cue-sheet', async (_, cueFilePath: string) => {
    try {
      const text = await readTextFile(cueFilePath);
      if (!text) return null;
      const sheet = parseCueSheet(text);
      if (!sheet) return null;
      return {
        albumTitle: sheet.albumTitle,
        albumArtist: sheet.albumArtist,
        isMultiFile: sheet.isMultiFile,
        tracks: sheet.tracks.map((track) => ({
          index: track.index,
          title: track.title,
          artist: track.artist,
          offset: track.offset,
          duration: track.duration,
          audioFile: track.audioFile
        }))
      };
    } catch (error: any) {
      console.error(`解析 CUE 文件失败: ${cueFilePath}`, error);
      return null;
    }
  });
}
