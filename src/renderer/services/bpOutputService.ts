// Bit-Perfect 输出服务（渲染层）
//
// 封装 preload 暴露的 bp:* IPC 通道，供 bitPerfect store 与播放链路使用。
// 非 Electron / 模块不可用 / 非 Windows 时所有方法返回降级值，播放自动落回 HTMLAudio。

export interface BpDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface BpSessionState {
  active: boolean;
  playing: boolean;
  eof: boolean;
  sampleRate: number;
  channels: number;
  format: string;
  shareMode: string;
  deviceName: string;
  totalFrames: number;
  playedFrames: number;
  seconds: number;
  duration: number;
  ended?: boolean;
}

export interface BpOpenResult {
  success: boolean;
  error?: string;
  code?: number;
  sampleRate?: number;
  channels?: number;
  format?: string;
  shareMode?: string;
  deviceName?: string;
  totalFrames?: number;
  duration?: number;
}

const EMPTY_STATE: BpSessionState = {
  active: false,
  playing: false,
  eof: false,
  sampleRate: 0,
  channels: 0,
  format: '',
  shareMode: '',
  deviceName: '',
  totalFrames: 0,
  playedFrames: 0,
  seconds: 0,
  duration: 0
};

const getApi = () => {
  // window.api 由 preload contextBridge 注入；非 Electron 环境为 undefined
  return typeof window !== 'undefined' ? (window as any).api : undefined;
};

const isElectronEnv = (): boolean => {
  const api = getApi();
  return !!api && typeof api.bpIsSupported === 'function';
};

/** 原生模块是否可用（平台/加载状态检查） */
export async function bpIsAvailable(): Promise<boolean> {
  if (!isElectronEnv()) return false;
  try {
    return (await getApi().bpIsSupported()) === true;
  } catch (error) {
    console.warn('[bp] isSupported 查询失败:', error);
    return false;
  }
}

export async function bpListDevices(): Promise<BpDevice[]> {
  if (!isElectronEnv()) return [];
  try {
    const devices = await getApi().bpListDevices();
    return Array.isArray(devices) ? devices : [];
  } catch (error) {
    console.warn('[bp] listDevices 失败:', error);
    return [];
  }
}

export async function bpOpen(opts: {
  path: string;
  deviceId?: string;
  exclusive?: boolean;
}): Promise<BpOpenResult> {
  if (!isElectronEnv()) return { success: false, error: 'Bit-Perfect 模块不可用', code: -100 };
  try {
    return await getApi().bpOpen(opts);
  } catch (error: any) {
    console.warn('[bp] open 失败:', error);
    return { success: false, error: String(error?.message || error), code: -101 };
  }
}

export async function bpPlay(): Promise<boolean> {
  if (!isElectronEnv()) return false;
  try {
    return (await getApi().bpPlay()) === true;
  } catch (error) {
    console.warn('[bp] play 失败:', error);
    return false;
  }
}

export async function bpPause(): Promise<boolean> {
  if (!isElectronEnv()) return false;
  try {
    return (await getApi().bpPause()) === true;
  } catch (error) {
    console.warn('[bp] pause 失败:', error);
    return false;
  }
}

export async function bpSeek(seconds: number): Promise<boolean> {
  if (!isElectronEnv()) return false;
  try {
    return (await getApi().bpSeek(seconds)) === true;
  } catch (error) {
    console.warn('[bp] seek 失败:', error);
    return false;
  }
}

export async function bpGetState(): Promise<BpSessionState> {
  if (!isElectronEnv()) return { ...EMPTY_STATE };
  try {
    const state = await getApi().bpGetState();
    return { ...EMPTY_STATE, ...(state || {}) };
  } catch (error) {
    console.warn('[bp] getState 失败:', error);
    return { ...EMPTY_STATE };
  }
}

export async function bpClose(): Promise<boolean> {
  if (!isElectronEnv()) return true;
  try {
    return (await getApi().bpClose()) === true;
  } catch (error) {
    console.warn('[bp] close 失败:', error);
    return false;
  }
}

/** 订阅主进程推送的会话状态变化（progress / end / 播放状态变更） */
export function bpOnStateChanged(callback: (state: BpSessionState) => void): () => void {
  const api = getApi();
  if (!api || typeof api.onBpStateChanged !== 'function') return () => {};
  api.onBpStateChanged(callback);
  return () => {
    if (typeof api.removeBpStateListeners === 'function') {
      api.removeBpStateListeners();
    }
  };
}
