import type { LocalMusicMeta } from './localMusic';

export interface IElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  dragStart: (_data: string) => void;
  miniTray: () => void;
  restart: () => void;
  openLyric: () => void;
  sendLyric: (_data: string) => void;
  unblockMusic: (_id: number) => Promise<string>;
  importCustomApiPlugin: () => Promise<{ name: string; content: string } | null>;
  importLxMusicScript: () => Promise<{ name: string; content: string } | null>;
  onLyricWindowClosed: (_callback: () => void) => void;
  onLyricWindowReady: (_callback: () => void) => void;
  onLanguageChanged: (_callback: (_locale: string) => void) => void;
  store: {
    get: (_key: string) => Promise<any>;
    set: (_key: string, _value: any) => Promise<boolean>;
    delete: (_key: string) => Promise<boolean>;
  };
  /** 扫描指定文件夹中的本地音乐文件 */
  scanLocalMusic: (_folderPath: string) => Promise<{ files: string[]; count: number }>;
  /** 扫描指定文件夹中的本地音乐文件（包含修改时间） */
  scanLocalMusicWithStats: (
    _folderPath: string
  ) => Promise<{
    files: { path: string; modifiedTime: number }[];
    cueFiles: { path: string; modifiedTime: number }[];
    count: number;
  }>;
  /** 批量解析本地音乐文件元数据 */
  parseLocalMusicMetadata: (_filePaths: string[]) => Promise<LocalMusicMeta[]>;
  /** 读取文本文件（自动检测编码），供 CUE 解析与旁挂 .lrc 歌词匹配 */
  readLocalTextFile: (_filePath: string) => Promise<string | null>;
  /** 列出目录下的文件名（旁挂 .lrc 歌词索引） */
  listLocalDirectory: (_dirPath: string) => Promise<string[]>;
  /** 解析 CUE 分轨表 */
  parseCueSheet: (
    _cueFilePath: string
  ) => Promise<{
    albumTitle: string;
    albumArtist: string;
    isMultiFile: boolean;
    tracks: {
      index: number;
      title: string;
      artist: string;
      offset: number;
      duration: number;
      audioFile: string;
    }[];
  } | null>;
  // Download manager
  downloadAdd: (_task: any) => Promise<string>;
  downloadAddBatch: (_tasks: any) => Promise<{ batchId: string; taskIds: string[] }>;
  downloadPause: (_taskId: string) => Promise<void>;
  downloadResume: (_taskId: string) => Promise<void>;
  downloadCancel: (_taskId: string) => Promise<void>;
  downloadCancelAll: () => Promise<void>;
  downloadGetQueue: () => Promise<any[]>;
  downloadSetConcurrency: (_n: number) => void;
  downloadGetCompleted: () => Promise<any[]>;
  downloadDeleteCompleted: (_filePath: string) => Promise<boolean>;
  downloadClearCompleted: () => Promise<boolean>;
  getEmbeddedLyrics: (_filePath: string) => Promise<string | null>;
  downloadProvideUrl: (_taskId: string, _url: string) => Promise<void>;
  onDownloadProgress: (_cb: (_data: any) => void) => void;
  onDownloadStateChange: (_cb: (_data: any) => void) => void;
  onDownloadBatchComplete: (_cb: (_data: any) => void) => void;
  onDownloadRequestUrl: (_cb: (_data: any) => void) => void;
  removeDownloadListeners: () => void;
}

declare global {
  interface Window {
    api: IElectronAPI;
  }
}
