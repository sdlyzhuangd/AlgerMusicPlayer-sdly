// bp_output.cc —— Bit-Perfect 输出原生插件（miniaudio + N-API）
//
// 职责（对齐 docs/bit-perfect-cue-implementation-guide.md 第二章）：
//   1. 用 miniaudio 打开 WASAPI 设备（先 Exclusive，失败回退 Shared，均失败则报错
//      交给渲染层回退 HTMLAudio 链路）
//   2. 格式级联：源格式 → f32 → s32 → s24 → s16，保持源采样率/声道不变（无重采样）
//   3. 数据回调直接从解码器读 PCM 帧写入设备，不做任何数字音量/DSP 处理（bit-perfect）
//   4. Seek / 暂停 / 恢复 / 位置查询；文件结束与节流进度通过 ThreadSafeFunction 上报
//
// 线程安全约定：
//   - 音频回调线程（pro audio 高优先级）内：只读解码器 + 原子计数 + NonBlockingCall，
//     零锁、零分配（除节流 ~5 次/秒的进度事件与一次性 end 事件）
//   - Seek/暂停由 JS 线程发起：先 ma_device_stop 再操作，避免与回调读解码器竞态
//   - 事件为尽力而为（NonBlockingCall 队列满则丢弃），渲染层另有 500ms 轮询兜底

#define MINIAUDIO_IMPLEMENTATION
#include "../miniaudio.h"

#include <napi.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

// ==================== 全局会话 ====================

struct BpSession {
  ma_context context{};
  bool contextInited = false;
  ma_device device{};
  bool deviceInited = false;
  ma_decoder decoder{};
  bool decoderInited = false;

  std::atomic<bool> playing{false};
  std::atomic<bool> eofReached{false};
  std::atomic<ma_uint64> playedFrames{0};
  std::atomic<ma_uint64> lastReportedFrame{0};
  ma_uint64 totalFrames = 0;
  ma_uint32 sampleRate = 0;
  ma_uint32 channels = 0;
  ma_format format = ma_format_unknown;
  std::string deviceName;
  std::string shareMode; // "exclusive" | "shared"

  Napi::ThreadSafeFunction tsfn;
};

static BpSession g_session;

// ==================== 工具函数 ====================

static std::string formatToString(ma_format f) {
  switch (f) {
    case ma_format_u8: return "u8";
    case ma_format_s16: return "s16";
    case ma_format_s24: return "s24";
    case ma_format_s32: return "s32";
    case ma_format_f32: return "f32";
    default: return "unknown";
  }
}

static std::wstring utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  if (len <= 0) return L"";
  std::wstring w(len, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], len);
  return w;
}

// WASAPI 的 ma_device_id.wasapi 成员是 wchar_t[64]（UTF-16 GUID 字符串）。
// 把 wchar 字符串转成 ASCII hex 作为可持久化的设备 id；反解时还原回 wchar 布局。
static std::string deviceIdToHex(const ma_device_id& id) {
  static const char* hex = "0123456789abcdef";
  std::string out;
  // WASAPI 后端：wasapi 成员为 UTF-16 字符串（含结尾 \0）
  const wchar_t* wstr = reinterpret_cast<const wchar_t*>(id.wasapi);
  size_t len = 0;
  while (len < 63 && wstr[len] != L'\0') len++;
  for (size_t i = 0; i < len; i++) {
    unsigned short ch = static_cast<unsigned short>(wstr[i]);
    // 只保留 ASCII 可打印（GUID 字符集），非 ASCII 截断
    if (ch > 0x7f) break;
    out.push_back(hex[(ch >> 4) & 0x0f]);
    out.push_back(hex[ch & 0x0f]);
  }
  if (out.empty()) {
    // 回退：完整字节 hex
    const unsigned char* p = reinterpret_cast<const unsigned char*>(&id);
    out.reserve(sizeof(ma_device_id) * 2);
    for (size_t i = 0; i < sizeof(ma_device_id); i++) {
      out.push_back(hex[p[i] >> 4]);
      out.push_back(hex[p[i] & 0x0f]);
    }
  }
  return out;
}

static bool hexToDeviceId(const std::string& hex, ma_device_id& out) {
  // 反解：hex 是 ASCII GUID 字符的 hex 编码；还原成 UTF-16 wchar 布局
  memset(&out, 0, sizeof(ma_device_id));
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  if (hex.size() % 2 != 0 || hex.size() > 63 * 2) return false;
  wchar_t* wstr = reinterpret_cast<wchar_t*>(out.wasapi);
  size_t chars = hex.size() / 2;
  for (size_t i = 0; i < chars; i++) {
    int hi = nib(hex[i * 2]);
    int lo = nib(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    wstr[i] = static_cast<wchar_t>((hi << 4) | lo);
  }
  wstr[chars] = L'\0';
  return true;
}

/** 通过 context 设备枚举反查设备名（按 id 匹配；pId 为空时返回默认设备名） */
static std::string lookupDeviceName(const ma_device_id* pId) {
  ma_device_info* pPlayback = nullptr;
  ma_uint32 count = 0;
  if (ma_context_get_devices(&g_session.context, &pPlayback, &count, nullptr, nullptr) !=
      MA_SUCCESS) {
    return "";
  }
  if (!pId) {
    for (ma_uint32 i = 0; i < count; i++) {
      if (pPlayback[i].isDefault == MA_TRUE) {
        return pPlayback[i].name;
      }
    }
    return count > 0 ? pPlayback[0].name : "";
  }
  for (ma_uint32 i = 0; i < count; i++) {
    if (memcmp(&pPlayback[i].id, pId, sizeof(ma_device_id)) == 0) {
      return pPlayback[i].name;
    }
  }
  return "";
}

static std::string lookupDefaultDeviceName() {
  return lookupDeviceName(nullptr);
}

/** 生成错误结果对象 { success: false, error, code } */
static Napi::Object makeError(Napi::Env env, const std::string& msg, int code = -1) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("success", Napi::Boolean::New(env, false));
  obj.Set("error", Napi::String::New(env, msg));
  obj.Set("code", Napi::Number::New(env, code));
  return obj;
}

// ==================== 事件上报 ====================

/**
 * 从任意线程（含音频回调线程）上报事件。
 * NonBlockingCall：队列满直接丢弃，绝不阻塞实时音频线程。
 * 渲染层通过 500ms 轮询 getPosition() 兜底，事件丢失不影响播放/切歌正确性。
 */
static void emitEvent(const char* type, ma_uint64 played) {
  Napi::ThreadSafeFunction tsfn = g_session.tsfn;
  if (!tsfn) return;
  tsfn.NonBlockingCall(
      [type = std::string(type), played](Napi::Env env, Napi::Function jsCallback) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("type", Napi::String::New(env, type));
        obj.Set("playedFrames", Napi::Number::New(env, static_cast<double>(played)));
        jsCallback.Call({obj});
      });
}

// ==================== 音频回调 ====================

static void dataCallback(ma_device* pDevice,
                         void* pOutput,
                         const void* pInput,
                         ma_uint32 frameCount) {
  (void)pInput;
  BpSession* bp = static_cast<BpSession*>(pDevice->pUserData);

  ma_uint64 framesRead = 0;
  ma_result result = ma_decoder_read_pcm_frames(&bp->decoder, pOutput, frameCount, &framesRead);

  if (result != MA_SUCCESS || framesRead < frameCount) {
    // 文件结束或读取错误：静音填充剩余帧，且仅上报一次 end
    const size_t bytesPerFrame =
        ma_get_bytes_per_frame(bp->decoder.outputFormat, bp->decoder.outputChannels);
    memset(static_cast<char*>(pOutput) + framesRead * bytesPerFrame, 0,
           (frameCount - framesRead) * bytesPerFrame);
    if (!bp->eofReached.exchange(true)) {
      emitEvent("end", bp->playedFrames.load());
    }
  }

  bp->playedFrames.fetch_add(framesRead);

  // 进度节流：每 ~200ms 上报一次（不在此处做任何音量处理 —— bit-perfect）
  ma_uint64 played = bp->playedFrames.load();
  ma_uint64 last = bp->lastReportedFrame.load();
  if (bp->sampleRate > 0 && played - last >= bp->sampleRate / 5) {
    if (bp->lastReportedFrame.compare_exchange_strong(last, played)) {
      emitEvent("progress", played);
    }
  }
}

// ==================== 会话生命周期 ====================

static void teardownDevice() {
  if (g_session.deviceInited) {
    ma_device_uninit(&g_session.device);
    g_session.deviceInited = false;
  }
}

static void teardownDecoder() {
  if (g_session.decoderInited) {
    ma_decoder_uninit(&g_session.decoder);
    g_session.decoderInited = false;
  }
}

static void releaseEventCallback() {
  if (g_session.tsfn) {
    g_session.tsfn.Release();
    g_session.tsfn = nullptr;
  }
}

static void resetState() {
  teardownDevice();
  teardownDecoder();
  g_session.playing.store(false);
  g_session.eofReached.store(false);
  g_session.playedFrames.store(0);
  g_session.lastReportedFrame.store(0);
  g_session.totalFrames = 0;
  g_session.sampleRate = 0;
  g_session.channels = 0;
  g_session.format = ma_format_unknown;
  g_session.deviceName.clear();
  g_session.shareMode.clear();
}

/**
 * 打开会话核心逻辑（供 Open 使用）：
 *   formatCascade: 候选格式列表
 *   shareMode: 独占/共享
 * 返回 MA_SUCCESS 且 g_session.deviceInited = true 表示成功。
 */
static ma_result openWithShareMode(const std::wstring& widePath,
                                   const ma_format* candidates,
                                   int candidateCount,
                                   ma_share_mode shareMode,
                                   ma_device_id* pDeviceId) {
  teardownDevice();
  teardownDecoder();

  ma_result lastErr = MA_FAILED_TO_INIT_BACKEND;
  for (int i = 0; i < candidateCount; i++) {
    ma_format fmt = candidates[i];
    if (fmt == ma_format_unknown) continue;

    // 按候选格式重新初始化解码器（保持源采样率/声道，无重采样）
    ma_decoder_config decCfg = ma_decoder_config_init(fmt, g_session.channels, g_session.sampleRate);
    if (ma_decoder_init_file_w(widePath.c_str(), &decCfg, &g_session.decoder) != MA_SUCCESS) {
      continue;
    }
    g_session.decoderInited = true;
    ma_decoder_get_length_in_pcm_frames(&g_session.decoder, &g_session.totalFrames);

    ma_device_config devCfg = ma_device_config_init(ma_device_type_playback);
    devCfg.playback.format = fmt;
    devCfg.playback.channels = g_session.channels;
    devCfg.sampleRate = g_session.sampleRate;
    devCfg.dataCallback = dataCallback;
    devCfg.pUserData = &g_session;
    // miniaudio 0.11.x: shareMode 位于 playback（v0.11.18+ 从 wasapi 移出）
    devCfg.playback.shareMode = shareMode;
    // 独占模式下禁用 miniaudio 自动重采样：采样率不被设备支持则直接失败，由调用方
    // 走共享模式回退（共享模式由 WASAPI 混音器处理转换，无法 bit-perfect 但保留直出）
    devCfg.wasapi.noAutoConvertSRC = (shareMode == ma_share_mode_exclusive) ? MA_TRUE : MA_FALSE;
    if (pDeviceId) {
      devCfg.playback.pDeviceID = pDeviceId;
    }

    ma_result result = ma_device_init(&g_session.context, &devCfg, &g_session.device);
    if (result == MA_SUCCESS) {
      g_session.deviceInited = true;
      g_session.format = fmt;
      g_session.shareMode = (shareMode == ma_share_mode_exclusive) ? "exclusive" : "shared";
  g_session.deviceName = pDeviceId ? lookupDeviceName(pDeviceId) : lookupDefaultDeviceName();
  return MA_SUCCESS;
    }
    lastErr = result;
    teardownDevice();
    teardownDecoder();
  }
  return lastErr;
}

// ==================== N-API 导出 ====================

static Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);

  if (!g_session.contextInited) {
    return out;
  }

  ma_device_info* pPlayback = nullptr;
  ma_uint32 count = 0;
  if (ma_context_get_devices(&g_session.context, &pPlayback, &count, nullptr, nullptr) !=
      MA_SUCCESS) {
    return out;
  }

  for (ma_uint32 i = 0; i < count; i++) {
    Napi::Object item = Napi::Object::New(env);
    item.Set("id", Napi::String::New(env, deviceIdToHex(pPlayback[i].id)));
    item.Set("name", Napi::String::New(env, pPlayback[i].name));
    item.Set("isDefault", Napi::Boolean::New(env, pPlayback[i].isDefault == MA_TRUE));
    out.Set(i, item);
  }
  return out;
}

static Napi::Value SetEventCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  releaseEventCallback();
  if (!info[0].IsFunction()) {
    return Napi::Boolean::New(env, false);
  }
  Napi::Function cb = info[0].As<Napi::Function>();
  g_session.tsfn = Napi::ThreadSafeFunction::New(env, cb, "bp-events", 0, 1);
  return Napi::Boolean::New(env, true);
}

static Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsObject()) {
    return makeError(env, "参数错误：需要 { path, deviceId?, exclusive? }");
  }
  Napi::Object opts = info[0].As<Napi::Object>();

  std::string filePath = opts.Get("path").As<Napi::String>().Utf8Value();
  if (filePath.empty()) {
    return makeError(env, "路径不能为空");
  }

  std::string deviceId;
  if (opts.Has("deviceId") && !opts.Get("deviceId").IsNull() &&
      !opts.Get("deviceId").IsUndefined()) {
    deviceId = opts.Get("deviceId").As<Napi::String>().Utf8Value();
  }
  bool exclusive = !opts.Has("exclusive") || opts.Get("exclusive").As<Napi::Boolean>().Value();

  // 关闭上一个会话。注意：保留 setEventCallback 注册的回调（tsfn），
  // 由 close() 或下一次 setEventCallback 负责释放，避免事件通道被误清。
  resetState();

  // 初始化 WASAPI context（仅 Windows）
  if (!g_session.contextInited) {
    ma_backend backends[] = {ma_backend_wasapi};
    ma_result r = ma_context_init(backends, 1, nullptr, &g_session.context);
    if (r != MA_SUCCESS) {
      return makeError(env, "WASAPI 初始化失败(ma_context_init): " + std::to_string(r), r);
    }
    g_session.contextInited = true;
  }

  // 探测源文件参数（默认配置 = 保持源格式）
  ma_decoder_config probeCfg = ma_decoder_config_init_default();
  if (ma_decoder_init_file_w(utf8ToWide(filePath).c_str(), &probeCfg, &g_session.decoder) !=
      MA_SUCCESS) {
    return makeError(env, "无法打开音频文件（解码器不支持该格式？）");
  }
  g_session.decoderInited = true;
  g_session.sampleRate = g_session.decoder.outputSampleRate;
  g_session.channels = g_session.decoder.outputChannels;
  ma_format srcFmt = g_session.decoder.outputFormat;
  ma_decoder_get_length_in_pcm_frames(&g_session.decoder, &g_session.totalFrames);
  teardownDecoder(); // 探测用解码器，稍后按候选格式重建

  if (g_session.sampleRate == 0 || g_session.channels == 0) {
    return makeError(env, "无法读取音频文件的采样率/声道信息");
  }

  // 解析目标设备 id
  ma_device_id targetId;
  ma_device_id* pDeviceId = nullptr;
  if (!deviceId.empty()) {
    if (!hexToDeviceId(deviceId, targetId)) {
      return makeError(env, "无效的 deviceId");
    }
    pDeviceId = &targetId;
  }

  // 格式级联：源格式 → f32 → s32 → s24 → s16
  ma_format cascade[] = {srcFmt, ma_format_f32, ma_format_s32, ma_format_s24, ma_format_s16};
  const int cascadeCount = sizeof(cascade) / sizeof(cascade[0]);

  ma_result result = MA_FAILED_TO_INIT_BACKEND;
  std::wstring widePath = utf8ToWide(filePath);

  if (exclusive) {
    result = openWithShareMode(widePath, cascade, cascadeCount, ma_share_mode_exclusive, pDeviceId);
    if (result != MA_SUCCESS) {
      // 独占失败 → 回退 WASAPI 共享模式（仍原生直出、无 DSP）
      result = openWithShareMode(widePath, cascade, cascadeCount, ma_share_mode_shared, pDeviceId);
      if (result == MA_SUCCESS) {
        g_session.shareMode = "shared-fallback";
      }
    }
  } else {
    result = openWithShareMode(widePath, cascade, cascadeCount, ma_share_mode_shared, pDeviceId);
    if (result == MA_SUCCESS) {
      g_session.shareMode = "shared";
    }
  }

  if (result != MA_SUCCESS || !g_session.deviceInited) {
    g_session.shareMode.clear();
    std::string errMsg = "设备打开失败(MA_BUSY 通常表示设备被其他程序独占): " + std::to_string(result);
    return makeError(env, errMsg, result);
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("success", Napi::Boolean::New(env, true));
  out.Set("sampleRate", Napi::Number::New(env, g_session.sampleRate));
  out.Set("channels", Napi::Number::New(env, g_session.channels));
  out.Set("format", Napi::String::New(env, formatToString(g_session.format)));
  out.Set("shareMode", Napi::String::New(env, g_session.shareMode));
  out.Set("deviceName", Napi::String::New(env, g_session.deviceName));
  out.Set("totalFrames", Napi::Number::New(env, static_cast<double>(g_session.totalFrames)));
  out.Set("duration",
          Napi::Number::New(env,
                            g_session.sampleRate > 0
                                ? static_cast<double>(g_session.totalFrames) /
                                      static_cast<double>(g_session.sampleRate)
                                : 0.0));
  return out;
}

static Napi::Value Play(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_session.deviceInited) {
    return Napi::Boolean::New(env, false);
  }
  g_session.eofReached.store(false);
  if (ma_device_start(&g_session.device) == MA_SUCCESS) {
    g_session.playing.store(true);
    return Napi::Boolean::New(env, true);
  }
  return Napi::Boolean::New(env, false);
}

static Napi::Value Pause(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_session.deviceInited) {
    return Napi::Boolean::New(env, false);
  }
  if (ma_device_stop(&g_session.device) == MA_SUCCESS) {
    g_session.playing.store(false);
    return Napi::Boolean::New(env, true);
  }
  return Napi::Boolean::New(env, false);
}

static Napi::Value Seek(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_session.deviceInited) {
    return Napi::Boolean::New(env, false);
  }
  double seconds = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().DoubleValue()
                                                           : 0.0;
  if (seconds < 0) seconds = 0;
  if (g_session.sampleRate == 0) {
    return Napi::Boolean::New(env, false);
  }

  bool wasPlaying = g_session.playing.load();
  if (wasPlaying) {
    ma_device_stop(&g_session.device); // 先停，避免与回调读解码器竞态
  }

  ma_uint64 target =
      static_cast<ma_uint64>(seconds * static_cast<double>(g_session.sampleRate));
  if (target > g_session.totalFrames) {
    target = g_session.totalFrames;
  }
  ma_result r = ma_decoder_seek_to_pcm_frame(&g_session.decoder, target);
  g_session.playedFrames.store(r == MA_SUCCESS ? target : 0);
  g_session.lastReportedFrame.store(g_session.playedFrames.load());
  g_session.eofReached.store(false);

  if (wasPlaying) {
    ma_device_start(&g_session.device);
  }
  return Napi::Boolean::New(env, r == MA_SUCCESS);
}

static Napi::Value GetPosition(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("active", Napi::Boolean::New(env, g_session.deviceInited));
  out.Set("playing", Napi::Boolean::New(env, g_session.playing.load()));
  out.Set("eof", Napi::Boolean::New(env, g_session.eofReached.load()));
  ma_uint64 played = g_session.playedFrames.load();
  out.Set("playedFrames", Napi::Number::New(env, static_cast<double>(played)));
  out.Set("totalFrames", Napi::Number::New(env, static_cast<double>(g_session.totalFrames)));
  out.Set("seconds",
          Napi::Number::New(env,
                            g_session.sampleRate > 0
                                ? static_cast<double>(played) /
                                      static_cast<double>(g_session.sampleRate)
                                : 0.0));
  out.Set("sampleRate", Napi::Number::New(env, g_session.sampleRate));
  out.Set("channels", Napi::Number::New(env, g_session.channels));
  out.Set("format", Napi::String::New(env, formatToString(g_session.format)));
  out.Set("shareMode", Napi::String::New(env, g_session.shareMode));
  out.Set("deviceName", Napi::String::New(env, g_session.deviceName));
  return out;
}

static Napi::Value Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  resetState();
  releaseEventCallback();
  return Napi::Boolean::New(env, true);
}

static Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // WASAPI 独占仅 Windows 可用；模块在其他平台编译时直接返回 false
#ifdef _WIN32
  return Napi::Boolean::New(env, true);
#else
  return Napi::Boolean::New(env, false);
#endif
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("setEventCallback", Napi::Function::New(env, SetEventCallback));
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("play", Napi::Function::New(env, Play));
  exports.Set("pause", Napi::Function::New(env, Pause));
  exports.Set("seek", Napi::Function::New(env, Seek));
  exports.Set("getPosition", Napi::Function::New(env, GetPosition));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

NODE_API_MODULE(bp_output, Init)
