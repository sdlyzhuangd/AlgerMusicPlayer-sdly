// local:// 协议回归测试编排：
//   1. 准备（转译 shared TS → CJS、生成 WAV/PNG/页面 fixture）
//   2. 单元测试（node --test，URL 编码往返 + 协议特权守卫）
//   3. Electron 集成测试（file:// 与 http origin 的真实加载）
// 任一环节失败则整体退出码非 0。

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const { ensurePrepared } = require('./prepare.cjs');
const { TMP_DIR, SHARED_DIR, FIXTURE_DIR, PAGE_FILE } = require('./prepare.cjs');

const ROOT = path.resolve(__dirname, '../..');

async function main() {
  let failed = false;

  // ---------- 1. 准备 ----------
  console.log('[run-all] 准备测试环境（转译 + fixtures）...');
  const { wavPath, pngPath } = ensurePrepared();
  console.log('[run-all] fixture wav:', wavPath);
  console.log('[run-all] fixture png:', pngPath);

  // ---------- 2. 单元测试 ----------
  console.log('\n[run-all] 运行单元测试...');
  const unit = spawnSync(process.execPath, ['--test', path.join(__dirname, 'unit.test.cjs')], {
    stdio: 'inherit',
    cwd: ROOT
  });
  if (unit.status !== 0) failed = true;

  // ---------- 3. Electron 集成测试 ----------
  console.log('\n[run-all] 运行 Electron 集成测试...');
  const electronPath = require('electron'); // 返回 electron 可执行文件路径
  const worker = path.join(__dirname, 'protocol.electron.cjs');
  const result = await awaitRun(electronPath, [worker], {
    ...process.env,
    SHARED_DIR,
    FIXTURE_WAV: wavPath,
    FIXTURE_PNG: pngPath,
    PAGE_FILE
  });
  if (result !== 0) failed = true;

  console.log(failed ? '\n[run-all] ✗ 存在失败用例' : '\n[run-all] ✓ 全部通过');
  process.exit(failed ? 1 : 0);
}

main();

function awaitRun(cmd, args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      errOut += d;
      process.stderr.write(d);
    });
    const timer = setTimeout(() => {
      console.error('[run-all] 超时，强制终止');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[run-all] electron 退出码: ${code}`);
      }
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[run-all] 启动失败:', err.message);
      resolve(1);
    });
  });
}
