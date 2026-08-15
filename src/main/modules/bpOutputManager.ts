// Bit-Perfect 输出管理模块（主进程）
//
// 职责（对齐 docs/bit-perfect-cue-implementation-guide.md 第三章）：
//   1. 加载原生模块 bp_output.node（miniaudio WASAPI 独占/共享输出）
//   2. IPC 桥：渲染层通过 ipcRenderer.invoke 调 listDevices/open/play/pause/seek/close，
//      原生进度/结束事件经主进程转发为 'bp-state-changed' 推给渲染层
//   3. 会话生命周期：单例会话、切歌时 close→open 异步窗口、退出时强制清理
//   4. 降级保护：原生模块缺失/加载失败/平台非 Windows 时所有方法返回空结果，
//      播放链路自动落回现有 HTMLAudio 路径，功能不阻塞

import { BrowserWindow,ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// 原生模块加载：
//  - 开发：native/build/Release/bp_output.node（需先执行 npm run rebuild:bp）
//  - 打包：electron-builder asarUnpack 解包后 Electron 自动重定向 .node 的 require
let nativeModule: any = null;
let nativeLoaded = false;

function resolveNativePath(): string | null {
  // 1) 开发模式：项目根的 native 目录
  const devCandidates = [
    path.join(__dirname, '../../native/build/Release/bp_output.node'),
    path.join(__dirname, '../../../native/build/Release/bp_output.node')
  ];
  for (const p of devCandidates) {
    if (fs.existsSync(p)) return p;
  }
  // 2) 打包模式：
  //    a) extraResources 布局：process.resourcesPath/native/bp_output.node
  //    b) asarUnpack 布局：process.resourcesPath/app.asar.unpacked/...
  const resource = path.join(process.resourcesPath, 'native', 'bp_output.node');
  if (fs.existsSync(resource)) return resource;
  const packed = path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'build', 'Release', 'bp_output.node');
  if (fs.existsSync(packed)) return packed;
  const packed2 = path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'bp_output.node');
  if (fs.existsSync(packed2)) return packed2;
  return null;
}

function loadNativeModule(): boolean {
  if (nativeLoaded) return true;
  if (process.platform !== 'win32') {
    console.log('[bp] 非 Windows 平台，Bit-Perfect 输出不可用');
    nativeLoaded = true; // 标记已尝试，避免重复尝试
    return false;
  }
  const nativePath = resolveNativePath();
  if (!nativePath) {
    console.warn('[bp] 未找到 bp_output.node，Bit-Perfect 输出不可用（播放将走 HTMLAudio 链路）');
    nativeLoaded = true;
    return false;
  }
  try {
     
    nativeModule = require(nativePath);
    if (typeof nativeModule?.isSupported === 'function' && !nativeModule.isSupported()) {
      nativeModule = null;
      return false;
    }
    console.log('[bp] 原生模块加载成功:', nativePath);
    nativeLoaded = true;
    return true;
  } catch (error) {
    console.error('[bp] 原生模块加载失败:', error);
    nativeModule = null;
    nativeLoaded = true;
    return false;
  }
}

// ==================== 会话状态 ====================

interface BpSessionState {
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

let currentWindow: BrowserWindow | null = null;

function pushState(state?: Partial<BpSessionState>) {
  if (!currentWindow || currentWindow.isDestroyed()) return;
  const merged = { ...getState(), ...(state || {}) };
  currentWindow.webContents.send('bp-state-changed', merged);
}

function getState(): BpSessionState {
  if (!nativeModule) return { ...EMPTY_STATE };
  try {
    const pos = nativeModule.getPosition();
    if (!pos || !pos.active) return { ...EMPTY_STATE };
    const duration =
      pos.sampleRate > 0 && pos.totalFrames > 0
        ? Number((pos.totalFrames / pos.sampleRate).toFixed(3))
        : 0;
    return {
      active: !!pos.active,
      playing: !!pos.playing,
      eof: !!pos.eof,
      sampleRate: pos.sampleRate || 0,
      channels: pos.channels || 0,
      format: pos.format || '',
      shareMode: pos.shareMode || '',
      deviceName: pos.deviceName || '',
      totalFrames: pos.totalFrames || 0,
      playedFrames: pos.playedFrames || 0,
      seconds: pos.seconds || 0,
      duration
    };
  } catch (error) {
    console.error('[bp] getPosition 失败:', error);
    return { ...EMPTY_STATE };
  }
}

// ==================== 切歌竞态保护 ====================

// 切歌时 close→open 的异步窗口保护：关闭旧会话后 400ms 内到达的
// 原生事件属于旧会话，直接丢弃（见文档 3.5 章节）
let staleEventUntil = 0;

// ==================== IPC 注册 ====================

export function initializeBpOutput(window: BrowserWindow): void {
  currentWindow = window;

  if (!loadNativeModule()) {
    // 原生模块不可用时仍注册 IPC 通道（返回降级结果），保证渲染层调用无异常
    registerIpcFallback();
    return;
  }

  // 原生事件转发：progress / end → bp-state-changed
  nativeModule.setEventCallback((ev: any) => {
    if (Date.now() < staleEventUntil) return; // 旧会话残留事件，丢弃
    const state = getState();
    if (ev?.type === 'end') {
      pushState({ ...state, eof: true, playing: false });
      // 歌曲结束：通知渲染层走现有 nextPlay 链路
      currentWindow?.webContents.send('bp-state-changed', { ...state, eof: true, playing: false, ended: true });
    } else if (ev?.type === 'progress') {
      pushState(state);
    }
  });

  // ---- invoke 通道 ----
  ipcMain.handle('bp:list-devices', () => {
    if (!nativeModule) return [];
    try {
      return nativeModule.listDevices();
    } catch (error) {
      console.error('[bp] listDevices 失败:', error);
      return [];
    }
  });

  ipcMain.handle('bp:open', (_event, opts: { path: string; deviceId?: string; exclusive?: boolean }) => {
    if (!nativeModule) return { success: false, error: 'Bit-Perfect 模块不可用', code: -100 };
    try {
      // 关闭上一个会话前标记残留窗口，防止旧事件串入新会话
      staleEventUntil = Date.now() + 400;
      const result = nativeModule.open(opts);
      if (result?.success) {
        pushState({ ...getState(), active: true, playing: false });
      }
      return result;
    } catch (error: any) {
      console.error('[bp] open 失败:', error);
      return { success: false, error: String(error?.message || error), code: -101 };
    }
  });

  ipcMain.handle('bp:play', () => {
    if (!nativeModule) return false;
    try {
      const ok = nativeModule.play() === true;
      if (ok) pushState({ ...getState(), playing: true, eof: false });
      return ok;
    } catch (error) {
      console.error('[bp] play 失败:', error);
      return false;
    }
  });

  ipcMain.handle('bp:pause', () => {
    if (!nativeModule) return false;
    try {
      const ok = nativeModule.pause() === true;
      if (ok) pushState({ ...getState(), playing: false });
      return ok;
    } catch (error) {
      console.error('[bp] pause 失败:', error);
      return false;
    }
  });

  ipcMain.handle('bp:seek', (_event, seconds: number) => {
    if (!nativeModule) return false;
    try {
      return nativeModule.seek(Number(seconds) || 0) === true;
    } catch (error: any) {
      console.error('[bp] seek 失败:', error);
      return false;
    }
  });

  ipcMain.handle('bp:get-state', () => {
    return getState();
  });

  ipcMain.handle('bp:close', () => {
    if (!nativeModule) return true;
    try {
      nativeModule.close();
      pushState({ ...EMPTY_STATE });
      return true;
    } catch (error: any) {
      console.error('[bp] close 失败:', error);
      return false;
    }
  });

  ipcMain.handle('bp:is-supported', () => {
    return !!nativeModule;
  });

  // 窗口销毁时清理会话
  window.on('closed', () => {
    if (nativeModule) {
      try {
        nativeModule.close();
      } catch {
        /* ignore */
      }
    }
    currentWindow = null;
  });
}

function registerIpcFallback(): void {
  ipcMain.handle('bp:list-devices', () => []);
  ipcMain.handle('bp:open', () => ({ success: false, error: 'Bit-Perfect 输出不可用', code: -100 }));
  ipcMain.handle('bp:play', () => false);
  ipcMain.handle('bp:pause', () => false);
  ipcMain.handle('bp:seek', () => false);
  ipcMain.handle('bp:get-state', () => ({ ...EMPTY_STATE }));
  ipcMain.handle('bp:close', () => true);
  ipcMain.handle('bp:is-supported', () => false);
}

/** 应用退出时强制清理会话（避免 WASAPI 独占句柄残留） */
export function shutdownBpOutput(): void {
  if (nativeModule) {
    try {
      nativeModule.close();
    } catch {
      /* ignore */
    }
  }
}

/** 供渲染层查询原生模块是否可用 */
export function isBpAvailable(): boolean {
  return !!nativeModule;
}

/** 供其他模块（如 MPRIS/SMTC 同步）获取当前会话状态 */
export function getBpSessionState(): BpSessionState {
  return getState();
}
