// Bit-Perfect 输出 Store
//
// 管理 BP 会话的渲染层状态：
//   - enabled：用户开关（持久化到 localStorage）
//   - supported：原生模块是否可用（win32 + 加载成功）
//   - devices：可用输出设备列表
//   - deviceId：用户选择的独占输出设备（'default' = 系统默认）
//   - session：当前会话状态（shareMode / sampleRate / bitDepth / deviceName 等）
//   - active：当前是否有激活的 BP 会话（决定播放链路分流与 UI 徽章显示）
//
// 播放集成：
//   - playbackController 在 playTrack 时检查 bitPerfectStore.mayUseFor(song)，
//     满足条件（启用 + 本地文件 + 模块可用 + Windows）则走 BP 会话而非 audioService
//   - 会话进度经主进程 bp-state-changed 事件 + 500ms 轮询兜底同步到 MusicHook.nowTime/allTime
//   - 歌曲结束（ended 事件）→ 复用现有 nextPlayOnEnd 链路

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

import {
  bpClose,
  type BpDevice,
  bpGetState,
  bpIsAvailable,
  bpListDevices,
  bpOnStateChanged,
  bpOpen,
  bpPause,
  bpPlay,
  bpSeek,
  type BpSessionState
} from '@/services/bpOutputService';
import { isElectron } from '@/utils';

// 原生模块可用性缓存（进程内只探测一次）
let supportedCache: boolean | null = null;

export const useBitPerfectStore = defineStore('bitPerfect', () => {
  // ==================== 状态 ====================

  /** 用户开关：本地音乐走 Bit-Perfect 独占输出 */
  const enabled = ref(localStorage.getItem('bitPerfectEnabled') === 'true');
  /** 原生模块是否可用（win32 + 加载成功） */
  const supported = ref(false);
  /** 可用输出设备 */
  const devices = ref<BpDevice[]>([]);
  /** 用户选择的设备 id（'default' = 系统默认设备） */
  const deviceId = ref(localStorage.getItem('bitPerfectDeviceId') || 'default');
  /** 当前会话状态 */
  const session = ref<BpSessionState>({
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
  });

  // ==================== CUE 子轨上下文 ====================

  /**
   * 当前会话的 CUE 偏移上下文（实现指南 3.x）：
   * 会话进度（秒）是音频文件中的绝对位置，需映射回子轨内时间；
   * 子轨结束 = 绝对位置到达 cueOffset + cueDuration。
   * 由 playbackController 打开会话时设置，非 CUE 歌曲为 null。
   */
  const cueContext = ref<{ offset: number; duration: number } | null>(null);
  /** 子轨结束已处理标志（防轮询检测与原生 onEnd 重复切歌，实现指南 3.4） */
  let cueEndHandled = false;

  /** 设置/清除 CUE 上下文，并重置结束检测标志 */
  const setCueContext = (ctx: { offset: number; duration: number } | null) => {
    cueContext.value = ctx;
    cueEndHandled = false;
  };

  // ==================== Computed ====================

  /** 是否有激活的 BP 会话（决定播放分流与徽章） */
  const isActive = (): boolean => session.value.active;

  /** 是否处于独占模式 */
  const isExclusive = (): boolean =>
    !!session.value.active && session.value.shareMode === 'exclusive';

  /** 是否适合对某首歌启用 BP（分流判定） */
  const mayUseFor = (playMusicUrl?: string): boolean => {
    if (!enabled.value) return false;
    if (!supported.value) return false;
    if (!isElectron) return false;
    if (!playMusicUrl || !playMusicUrl.startsWith('local://')) return false;
    return true;
  };

  // ==================== Actions ====================

  /** 初始化：探测模块可用性 + 加载设备列表 + 订阅状态事件 */
  const init = async () => {
    // 挂载全局引用：audioService 等同步路径需要判断 BP 会话是否激活
    ;(window as any).__bpStore = {
      isActive: () => session.value.active
    };

    if (supportedCache === null) {
      supportedCache = await bpIsAvailable();
    }
    supported.value = supportedCache;

    if (!supported.value) {
      session.value = { ...session.value, active: false };
      return;
    }

    await refreshDevices();

    // 订阅主进程会话状态推送（progress / end / 播放状态）
    bpOnStateChanged((state) => {
      const ended = !!(state as any).ended;
      session.value = { ...state };
      syncProgressToMusicHook(state, ended);
    });
  };

  /** 刷新可用设备列表 */
  const refreshDevices = async () => {
    devices.value = await bpListDevices();
    // 设备变化后校验用户选择是否仍有效
    if (
      deviceId.value !== 'default' &&
      !devices.value.some((d) => d.id === deviceId.value)
    ) {
      deviceId.value = 'default';
      localStorage.setItem('bitPerfectDeviceId', 'default');
    }
  };

  /** 设置用户开关 */
  const setEnabled = (value: boolean) => {
    enabled.value = value;
    localStorage.setItem('bitPerfectEnabled', String(value));
    if (!value) {
      // 关闭时释放会话
      void bpClose().then(() => {
        session.value = { ...session.value, active: false, playing: false };
        stopPolling();
      });
    }
  };

  /** 选择输出设备 */
  const setDeviceId = (value: string) => {
    deviceId.value = value;
    localStorage.setItem('bitPerfectDeviceId', value);
  };

  /** 打开 BP 会话（播放本地文件） */
  const openSession = async (
    filePath: string,
    exclusive: boolean = true
  ): Promise<boolean> => {
    if (!supported.value) return false;
    cueEndHandled = false;
    const result = await bpOpen({
      path: filePath,
      deviceId: deviceId.value === 'default' ? undefined : deviceId.value,
      exclusive
    });
    if (result.success) {
      const state = await bpGetState();
      session.value = { ...state, active: true };
      return true;
    }
    console.warn('[bp] openSession 失败:', result.error);
    return false;
  };

  /** 开始播放 */
  const play = async (): Promise<boolean> => {
    const ok = await bpPlay();
    if (ok) {
      session.value = { ...session.value, playing: true, eof: false };
    }
    return ok;
  };

  /** 暂停 */
  const pause = async (): Promise<boolean> => {
    const ok = await bpPause();
    if (ok) {
      session.value = { ...session.value, playing: false };
    }
    return ok;
  };

  /** 跳转（秒）。CUE 子轨传入的是子轨内时间，叠加偏移定位到文件绝对位置 */
  const seek = async (seconds: number): Promise<boolean> => {
    const abs = seconds + (cueContext.value?.offset || 0);
    return await bpSeek(Math.max(0, abs));
  };

  /** 关闭会话 */
  const closeSession = async (): Promise<boolean> => {
    const ok = await bpClose();
    cueContext.value = null;
    cueEndHandled = false;
    if (ok) {
      session.value = { ...session.value, active: false, playing: false };
      stopPolling();
    }
    return ok;
  };

  /** 子轨/文件结束统一切歌（幂等） */
  const handleSessionEnd = () => {
    if (cueEndHandled) return;
    cueEndHandled = true;
    void closeSession().then(() => {
      void import('@/store/modules/playlist').then(({ usePlaylistStore }) => {
        usePlaylistStore().nextPlayOnEnd();
      });
    });
  };

  /** 从会话状态轮询同步进度（每 500ms，兜底事件丢失） */
  const syncProgressToMusicHook = (state: BpSessionState, ended: boolean = false) => {
    if (!state.active) return;
    void import('@/hooks/MusicHook').then(({ nowTime, allTime, getLrcIndex, nowIndex }) => {
      const cue = cueContext.value;
      if (cue) {
        const local = Math.max(0, state.seconds - cue.offset);
        nowTime.value = cue.duration > 0 ? Math.min(cue.duration, local) : local;
        if (cue.duration > 0) {
          allTime.value = cue.duration;
        }
        const newIndex = getLrcIndex(nowTime.value);
        if (newIndex !== nowIndex.value) {
          nowIndex.value = newIndex;
        }
        if (
          !cueEndHandled &&
          (ended || (cue.duration > 0 && state.seconds >= cue.offset + cue.duration - 0.5))
        ) {
          handleSessionEnd();
        }
        return;
      }
      nowTime.value = state.seconds;
      if (state.duration > 0) {
        allTime.value = state.duration;
      }
      const newIndex = getLrcIndex(nowTime.value);
      if (newIndex !== nowIndex.value) {
        nowIndex.value = newIndex;
      }
      if (ended) {
        handleSessionEnd();
      }
    });
  };

  /** 启动 500ms 轮询（切歌/播放中由 playbackController 或事件驱动调用） */
  let pollTimer: number | null = null;
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = window.setInterval(async () => {
      if (!session.value.active) return;
      const state = await bpGetState();
      if (state.active) {
        session.value = { ...state };
        syncProgressToMusicHook(state);
      }
    }, 500);
  };
  const stopPolling = () => {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  // 开关关闭或窗口卸载时停止轮询
  watch(enabled, (v) => {
    if (v) startPolling();
    else stopPolling();
  });

  return {
    // 状态
    enabled,
    supported,
    devices,
    deviceId,
    session,
    // 判定
    isActive,
    isExclusive,
    mayUseFor,
    // CUE 上下文
    setCueContext,
    // 动作
    init,
    refreshDevices,
    setEnabled,
    setDeviceId,
    openSession,
    play,
    pause,
    seek,
    closeSession,
    startPolling,
    stopPolling
  };
});
