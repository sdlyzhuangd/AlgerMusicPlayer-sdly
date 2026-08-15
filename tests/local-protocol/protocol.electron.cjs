// Electron 集成测试 worker（由 run-all.cjs 以 `electron protocol.electron.cjs` 启动）
//
// 用与生产代码相同的 scheme 特权配置（src/shared/localScheme.ts 转译产物）和相同的
// 解码逻辑（src/shared/localUrl.ts 转译产物）验证：
//   - file:// origin（生产模式）与 http://127.0.0.1 origin（dev 模式）都能加载 local://
//   - fetch 整文件 200、Range 请求 206
//   - <audio>（crossOrigin=anonymous，与 app 一致）loadedmetadata + seek
//   - <img>（crossOrigin=anonymous）加载封面
// 这是对"standard: true 破坏 Windows 盘符路径"回归的端到端守卫：
// 如果将来有人给 local 协议加回 standard: true，这里会失败（URL 无法解析 / 媒体安全检查拒绝）。

const { app, protocol, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');

const SHARED_DIR = process.env.SHARED_DIR;
const WAV_PATH = process.env.FIXTURE_WAV;
const PNG_PATH = process.env.FIXTURE_PNG;
const PAGE_FILE = process.env.PAGE_FILE;

if (!SHARED_DIR || !WAV_PATH || !PNG_PATH || !PAGE_FILE) {
  console.error('[worker] 缺少环境变量，必须由 run-all.cjs 启动');
  process.exit(2);
}

const { LOCAL_SCHEME, LOCAL_SCHEME_PRIVILEGES } = require(path.join(SHARED_DIR, 'localScheme.js'));
const { filePathToLocalUrl, localUrlToFilePath } = require(path.join(SHARED_DIR, 'localUrl.js'));

protocol.registerSchemesAsPrivileged([{ scheme: LOCAL_SCHEME, privileges: LOCAL_SCHEME_PRIVILEGES }]);

// 与 src/main/modules/fileManager.ts 的 buildLocalFileResponse 保持一致的 Range 处理
function buildLocalFileResponse(filePath, total, rangeHeader) {
  const range416 = () =>
    new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });

  let start = 0;
  let end = total - 1;
  let partial = false;

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (!m[1] && !m[2])) return range416();
    if (m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), end);
    } else {
      start = Math.max(0, total - parseInt(m[2], 10));
    }
    if (start > end || start >= total) return range416();
    partial = true;
  }

  return new Response(
    Readable.toWeb(fs.createReadStream(filePath, { start, end })),
    {
      status: partial ? 206 : 200,
      headers: {
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ...(partial && { 'Content-Range': `bytes ${start}-${end}/${total}` })
      }
    }
  );
}

const results = [];
function check(name, cond, detail) {
  const ok = Boolean(cond);
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
  return ok;
}

const AUDIO_TIMEOUT_MS = 20000;

function loadAudioInWindow(win, url, { crossOrigin = false, seekTo = null } = {}) {
  const co = crossOrigin ? "a.crossOrigin = 'anonymous';" : '';
  const body = (() => {
    if (seekTo == null) {
      // 不带 seek：loadedmetadata 即可判定成功
      return `a.addEventListener('loadedmetadata', () => finish({ event: 'loadedmetadata', duration: a.duration }));`;
    }
    // 带 seek：必须等 canplay 后执行 seek，再等 seeked（loadedmetadata 不能提前结束）
    return `a.addEventListener('canplay', () => {
      let seekDone = false;
      const sFinish = (o) => { if (!seekDone) { seekDone = true; finish(o); } };
      a.addEventListener('seeked', () => sFinish({ event: 'seeked', currentTime: a.currentTime }));
      a.currentTime = ${seekTo};
      setTimeout(() => sFinish({ event: 'seek-timeout', currentTime: a.currentTime }), 8000);
    });`;
  })();
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const a = new Audio();
      ${co}
      a.preload = 'auto';
      let done = false;
      const finish = (o) => { if (!done) { done = true; resolve(o); } };
      ${body}
      a.addEventListener('error', () => finish({ event: 'error', code: a.error && a.error.code, message: a.error && a.error.message }));
      setTimeout(() => finish({ event: 'timeout' }), ${AUDIO_TIMEOUT_MS});
      a.src = '${url}';
      a.load();
    })`,
    true
  );
}

app.whenReady().then(async () => {
  const wavUrl = filePathToLocalUrl(WAV_PATH);
  const pngUrl = filePathToLocalUrl(PNG_PATH);

  protocol.handle(LOCAL_SCHEME, async (request) => {
    try {
      const filePath = path.normalize(localUrlToFilePath(request.url));
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat?.isFile()) return new Response(null, { status: 404 });
      return buildLocalFileResponse(filePath, stat.size, request.headers.get('range'));
    } catch (error) {
      console.error('[worker] handler error:', error);
      return new Response(null, { status: 500 });
    }
  });

  // http server 模拟 dev 模式页面来源
  const pageHtml = fs.readFileSync(PAGE_FILE);
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(pageHtml);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpUrl = `http://127.0.0.1:${server.address().port}/page.html`;

  const fileSize = fs.statSync(WAV_PATH).size;

  for (const [label, pageUrl, isFile] of [
    ['file:// origin (生产模式)', PAGE_FILE, true],
    ['http origin (dev模式)', httpUrl, false]
  ]) {
    console.log(`\n===== ${label} =====`);
    const win = new BrowserWindow({ show: false });
    try {
      if (isFile) {
        await win.loadFile(pageUrl);
      } else {
        await win.loadURL(pageUrl);
      }
    } catch (e) {
      check(`${label} 页面加载`, false, String(e));
      await new Promise((resolve) => {
        win.once('closed', resolve);
        win.destroy();
      });
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    // 1. fetch 整文件 → 200 + 完整字节数
    const r1 = await win.webContents.executeJavaScript(
      `fetch('${wavUrl}').then(async (res) => ({ status: res.status, bytes: (await res.arrayBuffer()).byteLength })).catch((e) => ({ error: String(e) }))`,
      true
    );
    check(`${label} fetch 整文件`, r1.status === 200 && r1.bytes === fileSize, JSON.stringify(r1));

    // 2. fetch Range → 206 + 指定字节数
    const r2 = await win.webContents.executeJavaScript(
      `fetch('${wavUrl}', { headers: { Range: 'bytes=1000-1999' } }).then(async (res) => ({ status: res.status, bytes: (await res.arrayBuffer()).byteLength, cr: res.headers.get('content-range') })).catch((e) => ({ error: String(e) }))`,
      true
    );
    check(
      `${label} fetch Range(206)`,
      r2.status === 206 && r2.bytes === 1000 && r2.cr === 'bytes 1000-1999/' + fileSize,
      JSON.stringify(r2)
    );

    // 3. audio + crossOrigin=anonymous（app 真实用法）→ loadedmetadata
    const r3 = await loadAudioInWindow(win, wavUrl, { crossOrigin: true });
    check(
      `${label} audio(crossOrigin) loadedmetadata`,
      r3.event === 'loadedmetadata' && r3.duration > 2.5 && r3.duration < 3.5,
      JSON.stringify(r3)
    );

    // 4. seek 到 1.5s（验证 Range/206 驱动进度跳转）
    const r4 = await loadAudioInWindow(win, wavUrl, { crossOrigin: true, seekTo: 1.5 });
    check(
      `${label} audio seek`,
      r4.event === 'seeked' && Math.abs(r4.currentTime - 1.5) < 0.3,
      JSON.stringify(r4)
    );

    // 5. 封面 img + crossOrigin=anonymous
    const r5 = await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        let done = false;
        const finish = (o) => { if (!done) { done = true; resolve(o); } };
        img.onload = () => finish({ event: 'loaded', w: img.naturalWidth });
        img.onerror = () => finish({ event: 'error' });
        img.src = '${pngUrl}';
      })`,
      true
    );
    check(`${label} 封面 img`, r5.event === 'loaded' && r5.w === 1, JSON.stringify(r5));

    // 6. 不存在的文件 → 404
    const r6 = await win.webContents.executeJavaScript(
      `fetch('${filePathToLocalUrl(path.join(path.dirname(WAV_PATH), '不存在.flac'))}').then((res) => ({ status: res.status })).catch((e) => ({ error: String(e) }))`,
      true
    );
    check(`${label} 不存在文件 404`, r6.status === 404, JSON.stringify(r6));

    // 等待窗口彻底关闭再开下一个，避免连续建窗出现 ERR_FAILED
    await new Promise((resolve) => {
      win.once('closed', resolve);
      win.destroy();
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n===== 汇总: ${results.length - failed}/${results.length} 通过 =====`);
  app.exit(failed === 0 ? 0 : 1);
});

// 必须监听 window-all-closed 且不做退出操作：Electron 在没有监听器时会在最后一个
// 窗口关闭后默认退出应用。测试会在窗口间切换并销毁窗口，退出时机由主流程末尾的
// app.exit() 统一控制。
app.on('window-all-closed', () => {
  // 阻止默认退出（空监听即可）
});
