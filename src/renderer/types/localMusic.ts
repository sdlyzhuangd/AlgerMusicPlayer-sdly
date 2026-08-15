// 本地音乐相关类型定义

/**
 * 支持的音频文件格式
 * 包含 mp3、flac、wav、ogg、m4a、aac 六种常见格式
 */
export const SUPPORTED_AUDIO_FORMATS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'] as const;

/** 支持的音频格式类型 */
export type SupportedAudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];

/**
 * 主进程返回的原始音乐元数据
 * 由主进程扫描模块解析音乐文件后生成
 */
export type LocalMusicMeta = {
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
  /** 封面图片缓存文件绝对路径（userData/AudioCovers/<hash>.<ext>），无封面时为 null */
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
  /**
   * CUE 子轨信息（存在即表示该条目是 CUE 分轨的子轨道）：
   * 引用（整轨或多文件）音频文件的绝对路径。
   * filePath 对 CUE 子轨也指向该音频文件（播放/存在性检查共用）。
   */
  cueFrom?: string;
  /** TRACK 编号（从 1 开始，见实现指南 7.5：cueIndex > 0 即 CUE 子轨） */
  cueIndex?: number;
  /** 子轨在音频文件中的起始秒数（INDEX 01） */
  cueOffset?: number;
  /** 子轨时长（秒） */
  cueDuration?: number;
};

/**
 * IndexedDB 中存储的本地音乐条目
 * 在 LocalMusicMeta 基础上增加唯一标识 id
 */
export type LocalMusicEntry = LocalMusicMeta & {
  /** 使用 filePath 的 hash 作为唯一 ID */
  id: string;
};
