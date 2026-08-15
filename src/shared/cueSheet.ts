// CUE 分轨表解析（纯逻辑，无任何依赖）
//
// 参照 docs/bit-perfect-cue-implementation-guide.md 7.1 / 7.3：
//   - 时间格式 MM:SS:FF（75 帧/秒，CD 标准），支持 MM:SS:FF.nnn 毫秒小数
//   - 只取 INDEX 01（播放起点），忽略 INDEX 00（前置间隙）
//   - 整轨 vs 多文件判断：所有 TRACK 引用同一文件 = 整轨，
//     时长由相邻 INDEX 01 时间差推算；多文件则各轨 duration 置 0，
//     由调用方从音频文件实际时长读取
//
// 本文件不做路径解析（shared 层不能引 node:path），TRACK 的 audioFile
// 保留 FILE 行的原始文件名，由主进程（有 node:path）解析为绝对路径。

export interface CueTrack {
  /** TRACK 编号（从 1 开始） */
  index: number;
  /** 曲目标题（TITLE） */
  title: string;
  /** 曲目艺术家（PERFORMER） */
  artist: string;
  /** INDEX 01 起始秒数 */
  offset: number;
  /**
   * 时长（秒）。
   * 整轨：下一轨 offset - 本轨 offset（最后一轨为 0，需用音频总时长补）；
   * 多文件：0（需从对应音频文件读取）。
   */
  duration: number;
  /** FILE 行声明的音频文件名（原始字符串，未解析为绝对路径） */
  audioFile: string;
}

export interface CueSheet {
  /** 专辑标题（全局 TITLE） */
  albumTitle: string;
  /** 专辑艺术家（全局 PERFORMER） */
  albumArtist: string;
  /** 整轨（所有 TRACK 共享一个音频文件）还是多文件 */
  isMultiFile: boolean;
  tracks: CueTrack[];
}

/** 支持的无引号 FILE 行文件类型 */
const FILE_TYPES = /^(WAVE|MP3|FLAC|AIFF|APE|WV|OGG|WAV|M4A)$/i;

/**
 * CUE 时间（MM:SS:FF 或 MM:SS:FF.nnn）转秒
 * @param value 时间字符串，如 '00:03:25'、'42:15:60'
 * @returns 秒数，非法输入返回 0
 */
export function cueTimeToSeconds(value: string): number {
  if (!value) return 0;
  const m = /^(\d{1,4}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(String(value).trim());
  if (!m) return 0;
  const minutes = parseInt(m[1], 10) || 0;
  const seconds = parseInt(m[2], 10) || 0;
  const frames = parseInt(m[3], 10) || 0; // 75 frames/s
  const fraction = m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0;
  return minutes * 60 + seconds + frames / 75 + fraction;
}

/** 去除首尾成对引号 */
function unquote(value: string): string {
  const s = value.trim();
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** 从 FILE 行提取音频文件名（支持带引号与不带引号两种格式） */
function extractAudioFile(line: string): string {
  const rest = line.replace(/^FILE\s+/i, '').trim();
  const quoted = /^"([^"]+)"\s+\w+$/.exec(rest);
  if (quoted) return quoted[1];
  const parts = rest.split(/\s+/);
  const type = parts[parts.length - 1] || '';
  if (FILE_TYPES.test(type)) {
    return unquote(parts.slice(0, -1).join(' '));
  }
  return '';
}

/**
 * 解析 CUE 文本
 * @param text CUE 文件内容
 * @returns 解析结果，无有效 TRACK 时返回 null
 */
export function parseCueSheet(text: string): CueSheet | null {
  const lines = text.split(/\r?\n/);
  const tracks: CueTrack[] = [];
  let albumTitle = '';
  let albumArtist = '';
  let currentAudioFile = '';
  let currentTrack: CueTrack | null = null;

  const pushTrack = () => {
    if (currentTrack) tracks.push(currentTrack);
    currentTrack = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^TITLE\s+/i.test(line)) {
      const val = unquote(line.replace(/^TITLE\s+/i, ''));
      if (currentTrack) currentTrack.title = val;
      else albumTitle = val;
    } else if (/^PERFORMER\s+/i.test(line)) {
      const val = unquote(line.replace(/^PERFORMER\s+/i, ''));
      if (currentTrack) currentTrack.artist = val;
      else albumArtist = val;
    } else if (/^FILE\s+/i.test(line)) {
      currentAudioFile = extractAudioFile(line);
    } else if (/^TRACK\s+\d+\s+AUDIO/i.test(line)) {
      pushTrack();
      const m = /^TRACK\s+(\d+)\s+AUDIO/i.exec(line);
      currentTrack = {
        index: m ? parseInt(m[1], 10) || 0 : 0,
        title: '',
        artist: '',
        offset: 0,
        duration: 0,
        audioFile: currentAudioFile
      };
    } else if (currentTrack && /^INDEX\s+01\s+/i.test(line)) {
      const timePart = line.replace(/^INDEX\s+01\s+/i, '').trim();
      currentTrack.offset = cueTimeToSeconds(timePart);
    }
  }
  pushTrack();

  if (tracks.length === 0) {
    return null;
  }

  // 整轨 vs 多文件：去重后的音频文件数量
  const allAudioFiles = new Set<string>();
  for (const track of tracks) {
    if (track.audioFile) allAudioFiles.add(track.audioFile.toLowerCase());
  }
  const isMultiFile = allAudioFiles.size > 1;

  if (!isMultiFile) {
    // 整轨：duration = 下一轨起始 - 本轨起始（最后一轨置 0，由调用方补）
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const nextOffset = i + 1 < tracks.length ? tracks[i + 1].offset : 0;
      track.duration = nextOffset > track.offset ? nextOffset - track.offset : 0;
    }
  }

  return {
    albumTitle,
    albumArtist,
    isMultiFile,
    tracks
  };
}
