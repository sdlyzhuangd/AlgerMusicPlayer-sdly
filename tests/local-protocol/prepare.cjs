// 测试准备模块：
// 1. 用 tsc 把 src/shared/localUrl.ts + localScheme.ts 转译为 CJS 到 .tmp/src/shared/，
//    让测试与生产代码共用同一份实现（而不是复制一份易漂移的逻辑）
// 2. 生成测试 fixture：带中文/空格路径的 WAV 音频、PNG 封面、测试页面
//
// 被 run-all.cjs 与 unit.test.cjs 共用（幂等，每次重新生成保证与源码同步）。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TMP_DIR = path.join(__dirname, '.tmp');
// 两个源文件都在 src/shared/ 下，tsc 公共根目录即 src/shared，产物直接输出到 .tmp/
const SHARED_DIR = TMP_DIR;
const FIXTURE_DIR = path.join(TMP_DIR, 'fixtures', '迅雷云盘 111'); // 模拟用户含中文/空格的音乐目录
const PAGE_FILE = path.join(TMP_DIR, 'page.html');

// 生成一个合法的 PCM WAV（440Hz 正弦波，16bit 单声道）
function generateWav(filePath, seconds = 3, sampleRate = 22050) {
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 32767 * 0.3);
    buf.writeInt16LE(v, 44 + i * 2);
  }

  fs.writeFileSync(filePath, buf);
  return filePath;
}

function transpileShared() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const sources = [
    path.join(ROOT, 'src', 'shared', 'localUrl.ts'),
    path.join(ROOT, 'src', 'shared', 'localScheme.ts')
  ];
  execFileSync(
    process.execPath,
    [
      tsc,
      ...sources,
      '--outDir',
      TMP_DIR,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--moduleResolution',
      'node',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { stdio: 'pipe' }
  );
}

function generateFixtures() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  // 1x1 PNG（透明）
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const pngPath = path.join(FIXTURE_DIR, 'cover.png');
  fs.writeFileSync(pngPath, Buffer.from(pngBase64, 'base64'));

  const wavPath = path.join(FIXTURE_DIR, '姚璎格 - 倩影.wav');
  generateWav(wavPath);

  fs.writeFileSync(
    PAGE_FILE,
    '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>local protocol test</title></head><body>ok</body></html>'
  );

  return { wavPath, pngPath };
}

function ensurePrepared() {
  transpileShared();
  return generateFixtures();
}

module.exports = { ensurePrepared, TMP_DIR, SHARED_DIR, FIXTURE_DIR, PAGE_FILE };
