# Bit-Perfect WASAPI 独占 + CUE 专辑实现指南

实现音乐采样率等信息的显示，并把Bit-Perfect+声卡独占状态显示在控制条上

## 一、架构概览

```
┌─────────────────┐     IPC      ┌──────────────────┐    N-API     ┌──────────────┐
│  渲染层 (JS)     │◄──────────►│  主进程 (Node.js)  │◄──────────►│  C++ 原生插件  │
│  BP Client       │             │  BP Output Manager │             │  miniaudio    │
│  进度/歌词/切歌   │             │  路径解析/会话管理   │             │  WASAPI独占    │
└─────────────────┘             └──────────────────┘             └──────────────┘
```

三层分工：
- **C++ 原生插件**：用 miniaudio 库操作 WASAPI Exclusive，解码音频文件，直接输出到 DAC
- **主进程管理层**：IPC 桥接，文件路径解析（CUE 子轨需要从音乐库查绝对路径），会话生命周期
- **渲染层客户端**：播放状态同步、进度条映射、CUE 子轨偏移/结束检测、歌词同步

## 二、C++ 原生层核心逻辑

### 2.1 初始化 WASAPI 后端

```cpp
// 必须指定 wasapi 后端，Exclusive 只在 WASAPI 上有效
ma_backend backends[] = { ma_backend_wasapi };
ma_context_init(backends, 1, NULL, &g_context);
```

### 2.2 打开独占播放

```cpp
// 1. 解码器初始化（保持源格式）
ma_decoder_config decoderConfig = ma_decoder_config_init_default();
ma_decoder_init_file_w(filePath, &decoderConfig, &decoder);  // Windows 用 _w 版本支持中文路径

// 2. 读取源文件参数
ma_uint32 outputSampleRate = decoder.outputSampleRate;
ma_uint32 outputChannels = decoder.outputChannels;
ma_format outputFormat = decoder.outputFormat;
ma_decoder_get_length_in_pcm_frames(&decoder, &totalFrames);

// 3. 配置设备为独占模式
ma_device_config deviceConfig = ma_device_config_init(ma_device_type_playback);
deviceConfig.playback.channels = outputChannels;
deviceConfig.sampleRate = outputSampleRate;
deviceConfig.playback.shareMode = ma_share_mode_exclusive;
deviceConfig.dataCallback = dataCallback;
deviceConfig.pUserData = &g_device;

// 4. 格式级联尝试（关键！很多 DAC 不支持 32bit 整数但支持 float32）
// 按源格式 → f32 → s32 → s24 → s16 依次尝试，保持源采样率不变
ma_format candidates[] = { outputFormat, ma_format_f32, ma_format_s32, ma_format_s24, ma_format_s16 };
for (auto& fmt : candidates) {
    ma_decoder_uninit(&decoder);
    decoderConfig = ma_decoder_config_init(fmt, outputChannels, outputSampleRate);
    ma_decoder_init_file_w(filePath, &decoderConfig, &decoder);
    deviceConfig.playback.format = fmt;
    if (ma_device_init(&g_context, &deviceConfig, &device) == MA_SUCCESS) {
        break;  // 成功
    }
}

// 5. 全部失败则回退共享模式
deviceConfig.playback.shareMode = ma_share_mode_shared;
ma_device_init(&g_context, &deviceConfig, &device);
```

### 2.3 数据回调（核心，无音量衰减）

```cpp
static void dataCallback(ma_device* pDevice, void* pOutput, const void* pInput, ma_uint32 frameCount) {
    // 直接从解码器读 PCM 帧，不做任何数字音量处理
    ma_uint64 framesRead = 0;
    ma_decoder_read_pcm_frames(&bp->decoder, pOutput, frameCount, &framesRead);
    
    // 文件结束检测
    if (framesRead < frameCount) {
        // 填零 + 通知播放结束
        bp->eof.store(true);
        bp->playing.store(false);
        g_onEndCallback.BlockingCall(...);
    }
    
    // 进度上报
    bp->playedFrames += framesRead;
    bp->progress.store(bp->playedFrames / bp->totalFrames);
}
```

### 2.4 进度/Seek/音量 API

```cpp
// Seek：秒 → PCM 帧号
ma_decoder_seek_to_pcm_frame(&decoder, seconds * sampleRate);

// 音量（可选，bit-perfect 模式下不应调用，保持满刻度）
ma_device_set_master_volume(&device, volume);  // volume 0.0~1.0
```

## 三、CUE 子轨道的 Bit-Perfect 处理

这是最关键的部分。CUE 子轨道的音频数据是**同一文件的不同时间区间**。

### 3.1 核心概念

```
整轨文件: [========= 45分钟 WAV =========]
CUE Track 1:  [0:00 ──── 3:45]
CUE Track 2:         [3:45 ──── 7:20]
CUE Track 3:                [7:20 ──── 12:05]
                     ↑cueOffset    ↑cueEnd=cueOffset+cueDuration
```

- `cueOffset`：子轨道在整轨文件中的起始秒数
- `cueDuration`：子轨道的时长
- `cueFullDuration`：整轨文件的总时长
- `cueEnd = cueOffset + cueDuration`：子轨道在整轨中的结束点

### 3.2 播放启动（渲染层 → 主进程 → C++）

```javascript
// 1. 打开整轨文件的 BP 会话（不是打开子轨道！）
var bpStarted = await openBitPerfectPlayback(整轨文件路径, { localFileId });

// 2. 如果是 CUE 子轨道，seek 到 cueOffset
if (song.cueIndex > 0) {
    controlBitPerfectPlayback('seek', { seconds: song.cueOffset });
    // 立即更新进度状态，避免进度条闪动
    bitPerfectState.progress = cueOffset / cueFullDuration;
}
```

### 3.3 进度条映射（整轨进度 → 子轨道进度）

```javascript
function getPlaybackCurrentSeconds() {
    var cueOffset = audio._cueOffset;  // 或 currentLocalSong.cueOffset
    var cueEnd = audio._cueEnd;        // cueOffset + cueDuration
    
    if (isCueTrack) {
        // BP 模式：progress 是整轨的比例 (0~1)
        var absSec = bitPerfectState.progress * cueFullDuration;
        // 映射到子轨道内：减去偏移，clamp 到 [0, cueDuration]
        return Math.max(0, Math.min(cueDuration, absSec - cueOffset));
    }
}

function getPlaybackDurationSeconds() {
    if (isCueTrack) return cueDuration;  // 不是整轨时长！
}
```

### 3.4 CUE 子轨道结束检测（核心难点）

BP 模式下没有 `timeupdate` 事件，需要**主动检测进度是否到达子轨道末尾**。

```javascript
// 方案一：2秒轮询（当前实现）
setInterval(function() {
    if (!bitPerfectState.active) return;
    var status = await getBitPerfectStatus();
    bitPerfectState.progress = status.progress;
    cueTrackEndedCheck();
}, 2000);

// 方案二：进度回调（C++ 层 NonBlockingCall）
// miniaudio dataCallback 中每 ~4800 帧上报一次 progress

function cueTrackEndedCheck() {
    var absSec = progress * cueFullDuration;
    var cueEnd = cueOffset + cueDuration;
    if (absSec >= cueEnd - 0.3) {
        // 子轨道结束：关闭当前会话，播放下一首
        controlBitPerfectPlayback('close');
        nextTrack();
    }
}
```

**关键：防重复触发**。CUE 结束检测和原生 `onEnd` 回调可能同时触发：

```javascript
var bitPerfectCueEndHandled = false;
function cueTrackEndedCheck() {
    if (bitPerfectCueEndHandled) return false;  // 已处理
    if (absSec >= cueEnd - 0.3) {
        bitPerfectCueEndHandled = true;         // 标记已处理
        controlBitPerfectPlayback('close');
        nextTrack();
    }
}
// 每次 openBitPerfectPlayback 时重置
bitPerfectCueEndHandled = false;
```

### 3.5 切歌时的会话切换窗口

关闭旧会话 → 打开新会话是异步的，旧会话的残留事件会干扰新会话：

```javascript
var bitPerfectSessionOpeningAt = 0;
function markBitPerfectSessionOpening() {
    bitPerfectSessionOpeningAt = performance.now();
}
function bitPerfectProgressHoldActive() {
    return (performance.now() - bitPerfectSessionOpeningAt) < 400;  // 400ms 窗口
}

// 进度回调中过滤
if (bitPerfectProgressHoldActive()) return;  // 丢弃旧会话残留事件
```

## 四、标准播放路径的 CUE 处理（对比）

标准路径用 `<audio>` 元素，CUE 处理更简单：

```javascript
// 1. 设置整轨文件为 src
audio.src = song.localUrl;

// 2. metadata 加载后 seek 到 cueOffset
audio.onloadedmetadata = function() {
    audio.currentTime = song.cueOffset;
};

// 3. 用 audio 元素属性标记 CUE 状态
audio._cueOffset = song.cueOffset;
audio._cueEnd = song.cueOffset + song.cueDuration;

// 4. timeupdate 监听子轨道结束
audio.addEventListener('timeupdate', function() {
    if (audio.currentTime >= audio._cueEnd - 0.15) {
        audio.pause();
        nextTrack();
    }
});

// 5. 进度计算
function getPlaybackCurrentSeconds() {
    var raw = audio.currentTime;
    if (isCue && raw < cueOffset) return 0;
    return isCue ? Math.min(cueDuration, raw - cueOffset) : raw;
}
function getPlaybackDurationSeconds() {
    return isCue ? cueDuration : audio.duration;
}
```

## 五、环回可视化（Loopback Capture）

BP 独占模式下，常规 AudioContext 无法捕获输出音频。需要单独开一个 WASAPI 环回采集：

```cpp
// C++ 层：在同一设备上开 capture 模式
ma_device_config loopbackConfig = ma_device_config_init(ma_device_type_capture);
loopbackConfig.capture.format = ma_format_f32;
loopbackConfig.capture.channels = outputChannels;
loopbackConfig.sampleRate = outputSampleRate;
loopbackConfig.dataCallback = loopbackDataCallback;
loopbackConfig.capture.shareMode = ma_share_mode_shared;  // 环回必须是共享模式
loopbackConfig.capture.pDeviceID = &playbackDeviceId;      // 同一个设备
ma_device_init(&g_context, &loopbackConfig, &loopbackDevice);
ma_device_start(&loopbackDevice);
```

渲染层接收环回数据后喂给 AnalyserNode 驱动可视化。

## 六、完整的操作时序

```
用户点击播放 CUE 子轨道
  │
  ├─ 判断是否 BP 启用
  │   ├─ 是 → openBitPerfectPlayback(整轨路径)
  │   │       ├─ C++ 打开文件 + 初始化解码器
  │   │       ├─ 尝试 Exclusive 模式（格式级联）
  │   │       ├─ 成功 → 返回 sampleRate/bitDepth/exclusive=true
  │   │       └─ 失败 → 回退 Shared，返回 exclusive=false
  │   │
  │   │   seek 到 cueOffset
  │   │   重置 bitPerfectCueEndHandled = false
  │   │   markBitPerfectSessionOpening()
  │   │
  │   │   2s 轮询 + 进度回调 → 映射子轨道进度 → 检测结束
  │   │
  │   └─ 否 → 标准 audio 路径
  │           audio.src = 整轨 URL
  │           audio.currentTime = cueOffset
  │           timeupdate 监听 → audio._cueEnd 时切歌
  │
  └─ 进度条：duration=cueDuration, current=映射后的子轨道位置
      歌词同步：用子轨道内的时间戳
```

## 七、CUE 文件解析

### 7.1 CUE 时间格式

CUE 文件使用 `MM:SS:FF` 格式，其中 FF 是帧数（75帧/秒，CD 标准）：

```
INDEX 01 00:03:25    → 0分3秒25帧 = 3 + 25/75 = 3.333秒
INDEX 01 42:15:60    → 42分15秒60帧 = 2535 + 60/75 = 2535.8秒
```

解析函数：

```javascript
function cueTimeToSeconds(value) {
  if (!value) return 0;
  // 支持 MM:SS:FF 和 MM:SS:FF.nnn（毫秒小数）
  var m = /^(\d{1,4}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(String(value).trim());
  if (!m) return 0;
  var minutes = parseInt(m[1], 10) || 0;
  var seconds = parseInt(m[2], 10) || 0;
  var frames = parseInt(m[3], 10) || 0;   // 75 frames per second
  var fraction = m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0;
  return minutes * 60 + seconds + frames / 75 + fraction;
}
```

### 7.2 CUE 文件编码检测

CUE 文件可能用 UTF-8、UTF-16 LE/BE、GBK 等编码，需要自动检测：

```javascript
function decodeCueBuffer(buffer) {
  // UTF-8 BOM
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  // UTF-16 BE BOM
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    // 交换字节序后按 utf16le 解码
    ...
  }
  // 尝试严格 UTF-8，失败回退 GB18030（中文 CUE 常见编码）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return new TextDecoder('gb18030').decode(buffer);
  }
}
```

### 7.3 CUE 文件解析

```javascript
function parseCueSheet(text, cueFilePath) {
  var lines = text.split(/\r?\n/);
  var tracks = [];
  var albumTitle = '';
  var albumArtist = '';
  var currentAudioFile = '';
  var currentTrack = null;

  function unquote(value) {
    var s = value.trim();
    if (s.length >= 2 && ((s[0]==='"' && s[s.length-1]==='"') || (s[0]==="'" && s[s.length-1]==="'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  function resolveAudioFile(audioFile) {
    if (!audioFile) return '';
    if (path.isAbsolute(audioFile)) return audioFile;
    return path.resolve(path.dirname(cueFilePath), audioFile);
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    if (/^TITLE\s+/i.test(line)) {
      var val = unquote(line.replace(/^TITLE\s+/i, ''));
      if (!currentTrack) albumTitle = val;    // 专辑标题
      else currentTrack.title = val;          // 曲目标题
    }
    else if (/^PERFORMER\s+/i.test(line)) {
      var val = unquote(line.replace(/^PERFORMER\s+/i, ''));
      if (!currentTrack) albumArtist = val;   // 专辑艺术家
      else currentTrack.artist = val;         // 曲目艺术家
    }
    else if (/^FILE\s+/i.test(line)) {
      // FILE "陈瑞-剪爱.wav" WAVE
      var rest = line.replace(/^FILE\s+/i, '');
      var m = rest.match(/^"([^"]+)"\s+(\w+)$/);
      if (m) currentAudioFile = m[1];
      else {
        // 无引号格式：FILE 陈瑞-剪爱.wav WAVE
        var parts = rest.split(/\s+/);
        var type = parts[parts.length - 1];
        if (/^(WAVE|MP3|FLAC|AIFF|APE|WV|OGG)$/i.test(type)) {
          currentAudioFile = unquote(parts.slice(0, -1).join(' '));
        }
      }
    }
    else if (/^TRACK\s+(\d+)\s+AUDIO/i.test(line)) {
      if (currentTrack) tracks.push(currentTrack);
      currentTrack = {
        index: parseInt(RegExp.$1, 10) || 0,   // TRACK 编号，从1开始
        title: '',
        artist: '',
        indexTime: 0,
        audioFile: currentAudioFile
      };
    }
    else if (currentTrack && /^INDEX\s+01\s+/i.test(line)) {
      // 只取 INDEX 01（播放起点），忽略 INDEX 00（前置间隙）
      var timePart = line.replace(/^INDEX\s+01\s+/i, '').trim();
      currentTrack.indexTime = cueTimeToSeconds(timePart);
    }
  }
  if (currentTrack) tracks.push(currentTrack);
  if (!tracks.length) return null;

  // ---- 关键：区分整轨 vs 多文件 ----
  var allAudioFiles = new Set();
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i].audioFile) allAudioFiles.add(tracks[i].audioFile);
  }
  var isMultiFile = allAudioFiles.size > 1;

  var resolvedTracks = [];
  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    var resolvedAudioPath = resolveAudioFile(track.audioFile);

    if (isMultiFile) {
      // 多文件：每个 TRACK 对应独立音频文件，duration 由文件本身决定
      resolvedTracks.push({
        index: track.index,
        title: track.title,
        artist: track.artist,
        offset: track.indexTime,      // 通常是0
        duration: 0,                   // 需要从实际文件读取
        audioPath: resolvedAudioPath,
        albumTitle: albumTitle,
        albumArtist: albumArtist,
      });
    } else {
      // 整轨：所有 TRACK 共享同一个文件，duration = 下一轨起始 - 本轨起始
      var nextTime = (i + 1 < tracks.length) ? tracks[i + 1].indexTime : 0;
      resolvedTracks.push({
        index: track.index,
        title: track.title,
        artist: track.artist,
        offset: track.indexTime,
        duration: nextTime > track.indexTime ? (nextTime - track.indexTime) : 0,
        audioPath: resolvedAudioPath,
        albumTitle: albumTitle,
        albumArtist: albumArtist,
      });
    }
  }

  return {
    audioPath: resolveAudioFile(tracks[0].audioFile),
    tracks: resolvedTracks,
    albumTitle: albumTitle,
    albumArtist: albumArtist,
    isMultiFile: isMultiFile,
  };
}
```

### 7.4 整轨 vs 多文件 CUE 的关键区别

```
整轨 CUE (单文件):
  FILE "album.wav" WAVE
    TRACK 01 AUDIO  INDEX 01 00:00:00   → offset=0,     duration=225s (下一个INDEX-当前INDEX)
    TRACK 02 AUDIO  INDEX 01 03:45:00   → offset=225s,   duration=210s
    TRACK 03 AUDIO  INDEX 01 07:15:00   → offset=435s,   duration=295s
  ────────────────────────────────────────
  所有 TRACK 指向同一个 album.wav
  duration 可由相邻 INDEX 时间差算出
  BP 播放时：打开 album.wav，seek 到 offset，检测到 offset+duration 时切歌

多文件 CUE:
  FILE "01.wav" WAVE
    TRACK 01 AUDIO  INDEX 01 00:00:00   → offset=0, duration=从文件读
  FILE "02.wav" WAVE
    TRACK 02 AUDIO  INDEX 01 00:00:00   → offset=0, duration=从文件读
  ────────────────────────────────────────
  每个 TRACK 指向不同文件
  duration 需要从实际文件头/元数据读取
  BP 播放时：每轨打开对应文件，无 offset seek，文件结束即切歌
```

### 7.5 Track 1 的 CUE 子轨道判断

**重要**：Track 1 的 `cueOffset` 是 0（INDEX 01 00:00:00），不能用来判断是否为 CUE 子轨道。

错误判断：
```javascript
// ✗ 错误！Track 1 的 cueOffset=0，会被误判为非 CUE 轨道
var isCue = cueOffset > 0;
```

正确判断：
```javascript
// ✓ 正确：cueIndex > 0 且 cueDuration > 0
var isCueSubTrack = cueIndex > 0 && cueDuration > 0;
```

CUE 的 TRACK 编号从 1 开始（`TRACK 01 AUDIO`），所以所有 CUE 子轨道（包括 Track 1）的 `cueIndex` 都 > 0。

### 7.6 导入时的去重

导入整轨 WAV + CUE 时，CUE 引用的音频文件不应作为独立条目出现：

```javascript
function normalizeImportEntries(entries) {
  var cueAudioPaths = new Set();
  // 先收集所有 CUE 引用的音频路径
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].cueFrom) {
      cueAudioPaths.add(entries[i].path);  // CUE 引用的音频文件路径
    }
  }
  // 过滤掉与 CUE 子轨道重复的音频文件
  return entries.filter(function(entry) {
    if (!entry.cueFrom && cueAudioPaths.has(entry.path)) return false;  // 被CUE引用，跳过
    return true;
  });
}
```

### 7.7 CUE 子轨道歌词匹配

按曲名匹配同目录下的 .lrc 文件：

```javascript
// 建立目录 → {文件名→路径} 的索引
async function buildLrcSidecarIndex(entries) {
  var directories = [...new Set(entries.map(e => path.dirname(e.path)))];
  var maps = new Map();
  for (var dir of directories) {
    var lookup = new Map();
    var names = await fs.promises.readdir(dir);
    for (var name of names) {
      if (path.extname(name).toLowerCase() !== '.lrc') continue;
      lookup.set(path.basename(name, path.extname(name)).toLowerCase(), path.join(dir, name));
    }
    maps.set(dir, lookup);
  }
  return maps;
}

// 导入 CUE 子轨道时，用曲名匹配 .lrc
if (!lyric && cueTitle) {
  var dirLookup = sidecarDirectories.get(path.dirname(entry.path));
  var lrcPath = dirLookup && dirLookup.get(cueTitle.toLowerCase());
  if (lrcPath) {
    lyric = decodeLyricBuffer(await fs.promises.readFile(lrcPath));
    lyricSource = 'sidecar';
  }
}
```

## 八、注意事项

1. **中文路径**：Windows 上必须用 `ma_decoder_init_file_w()` + UTF-16 转换
2. **格式级联**：很多 USB DAC 不支持 s32@384kHz 独占但支持 f32@384kHz，必须逐个尝试
3. **会话切换**：close→open 是异步的，必须用时间窗口过滤残留事件
4. **CUE 结束检测**：BP 没有 timeupdate，必须主动轮询 + 进度回调
5. **防重复切歌**：CUE 结束和文件结束可能同时触发，需要幂等标志
6. **进度条稳定**：用 `audio._cueEnd/_cueOffset` 而非 `currentLocalSong` 判断 CUE 状态，避免对象被异步置空导致闪烁
7. **音量**：BP 独占下不做数字音量衰减（原码直出），音量由 DAC 硬件旋钮或 HID 控制
