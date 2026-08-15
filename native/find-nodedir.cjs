// find-nodedir.cjs
// 解析 Electron headers 目录（node-gyp --nodedir）用于 bp_output.node 构建。
// 兼容 npmmirror 精简版 headers tarball：若 Release/node.lib 缺失但 x64/node.lib
// 存在（Electron 新版 headers 布局），自动复制一份，避免 MSB4019/链接失败。
// 用法：node find-nodedir.cjs  → 打印 nodedir 绝对路径（找不到则退出码 1）

const fs = require('fs');
const os = require('os');
const path = require('path');

// 从项目依赖中解析 Electron 实际版本，避免硬编码
let electronVersion = '40.10.6';
try {
  const electronPkg = require(path.join(__dirname, '..', 'node_modules', 'electron', 'package.json'));
  if (electronPkg && electronPkg.version) electronVersion = electronPkg.version;
} catch {
  // 保留默认值
}

// 候选位置：node-gyp / @electron/rebuild 的标准缓存目录
const candidates = [
  path.join(os.homedir(), '.electron-gyp', electronVersion),
  path.join(process.env.USERPROFILE || '', '.electron-gyp', electronVersion),
  path.join(process.env.LOCALAPPDATA || '', 'electron-gyp', electronVersion)
];

const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'include', 'node', 'node.h')));
if (!found) {
  console.error(`[find-nodedir] 未找到 Electron v${electronVersion} headers`);
  console.error('  请先运行: npx electron-rebuild -f  （会自动下载完整 headers）');
  process.exit(1);
}

// Electron 新版 headers 的 node.lib 位于 x64/ 而非 Release/；node-gyp 固定查找
// Release/node.lib。npmmirror 精简 tarball 常缺 Release/，这里做兼容复制。
const releaseLib = path.join(found, 'Release', 'node.lib');
const x64Lib = path.join(found, 'x64', 'node.lib');
if (!fs.existsSync(releaseLib) && fs.existsSync(x64Lib)) {
  try {
    fs.mkdirSync(path.join(found, 'Release'), { recursive: true });
    fs.copyFileSync(x64Lib, releaseLib);
    console.error(`[find-nodedir] 已将 x64/node.lib 复制为 Release/node.lib`);
  } catch (err) {
    console.error(`[find-nodedir] 复制 node.lib 失败: ${err.message}`);
    process.exit(1);
  }
}

console.log(found); // 必须带换行，cmd 的 for /f 才能按行捕获
