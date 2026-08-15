# local:// 协议回归测试

## 背景（为什么需要这些测试）

`local://` 协议负责把本地音乐文件（`local:///E%3A/迅雷云盘/...` 形式）交给 Chromium
的 `<audio>`/`<img>` 加载。曾在注册协议特权时误加 `standard: true`，导致：

- `%3A` 编码的盘符 URL 直接 `Failed to parse URL` / 被媒体安全检查拒绝
  （`MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`）
- 裸冒号 URL 的盘符被 Chromium 当 host 吞掉（`local://e/...`）→ 404

表现为"本地音乐全部播放失败，播放下一首"。修复方式是保持协议为非 standard
（opaque URL，request.url 原样透传，主进程 `decodeURIComponent` 还原）。

本测试套件守护两条防线：

1. **单元测试**：`filePathToLocalUrl` ↔ `localUrlToFilePath` 往返一致；
   协议特权配置不得包含 `standard`。
2. **Electron 集成测试**：用与生产相同的特权配置与解码逻辑，在真实 Electron
   里验证 fetch / Range 206 / audio / seek / 封面 img（file:// 与 http origin）。

## 运行

```bash
npm run test:local-protocol
```

或分步：

```bash
node tests/local-protocol/prepare.cjs          # 转译 shared TS + 生成 fixtures
node --test tests/local-protocol/unit.test.cjs # 单元测试
node tests/local-protocol/run-all.cjs          # 全部（含 Electron 集成）
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `prepare.cjs` | tsc 转译 `src/shared/localUrl.ts`/`localScheme.ts` → `.tmp/`；生成 WAV/PNG/页面 fixture |
| `unit.test.cjs` | node:test 单元测试（编码往返 + 特权守卫） |
| `protocol.electron.cjs` | Electron worker：端到端验证 local:// 加载 |
| `run-all.cjs` | 编排：prepare → 单元 → Electron 集成 |

测试 fixture 与转译产物在 `tests/local-protocol/.tmp/`（已 gitignore）。
