// 单元测试：local:// 协议 URL 编码/解码往返 + 协议特权配置回归守卫
//
// 背景（回归原因）：local 协议曾注册 standard: true，Windows 盘符路径被 Chromium
// 把首段 E: 当 host 吞掉（local://e/xxx → 404），%3A 编码形式则直接 Failed to parse
// URL / 被媒体安全检查拒绝，导致本地音乐全部“播放失败”。修复为保持非 standard 后，
// 以下测试守护编码往返与特权配置不被破坏。
//
// 运行：npm run test:local-protocol（或先 node tests/local-protocol/prepare.cjs 再
// node --test tests/local-protocol/unit.test.cjs）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ensurePrepared } = require('./prepare.cjs');
ensurePrepared();

// 这里 require 的是 tsc 转译出的生产代码（src/shared/*.ts），不是测试内复制品
const { filePathToLocalUrl, localUrlToFilePath } = require('./.tmp/localUrl.js');
const { LOCAL_SCHEME, LOCAL_SCHEME_PRIVILEGES } = require('./.tmp/localScheme.js');

const isWin = process.platform === 'win32';
const normalize = (p) => path.normalize(p);
const roundTrip = (p) => localUrlToFilePath(filePathToLocalUrl(p));

test('URL 编码：分隔符不编码为 %2F，盘符编码为 %3A，中文按段编码', () => {
  const url = filePathToLocalUrl('E:\\迅雷云盘\\111\\姚璎格 - 倩影.flac');
  assert.ok(url.startsWith('local:///'), '应生成 local:/// 前缀');
  assert.ok(!url.includes('%2F'), '路径分隔符不应编码成 %2F（需保留目录结构）');
  assert.ok(url.includes('E%3A'), '盘符冒号应编码为 %3A');
  assert.ok(url.includes('%E8%BF%85%E9%9B%B7%E4%BA%91%E7%9B%98'), '中文应按 UTF-8 段编码');
  assert.ok(url.includes('%20'), '空格应编码为 %20');
});

test('Windows：盘符 + 中文 + 空格 + 括号 往返一致', { skip: !isWin }, () => {
  const p = 'E:\\迅雷云盘\\111\\姚璎格.粤.无双\\姚璎格 - 倩影 (伴奏).flac';
  assert.equal(normalize(roundTrip(p)), normalize(p));
});

test('Windows：特殊字符 # ? % 往返一致', { skip: !isWin }, () => {
  const p = 'D:\\my music\\a#b?c%d\\song.mp3';
  assert.equal(normalize(roundTrip(p)), normalize(p));
});

test('Windows：UNC 网络路径往返一致', { skip: !isWin }, () => {
  const p = '\\\\nas\\music\\album\\song.flac';
  assert.equal(normalize(roundTrip(p)), normalize(p));
});

test('macOS/Linux：绝对路径（含中文与空格）往返一致', { skip: isWin }, () => {
  const p = '/Users/alice/Music/夏夜晚风 - 伴奏.flac';
  assert.equal(roundTrip(p), p);
});

test('协议特权配置不得包含 standard: true（核心回归守卫）', () => {
  assert.equal(LOCAL_SCHEME, 'local');
  assert.ok(
    !('standard' in LOCAL_SCHEME_PRIVILEGES),
    'standard: true 会让 Chromium 把盘符当 host 吞掉或拒绝解析 %3A URL，本地音乐将无法播放'
  );
  assert.equal(LOCAL_SCHEME_PRIVILEGES.secure, true);
  assert.equal(LOCAL_SCHEME_PRIVILEGES.supportFetchAPI, true);
  assert.equal(LOCAL_SCHEME_PRIVILEGES.stream, true);
  assert.equal(LOCAL_SCHEME_PRIVILEGES.bypassCSP, true);
  assert.equal(LOCAL_SCHEME_PRIVILEGES.corsEnabled, true);
});
