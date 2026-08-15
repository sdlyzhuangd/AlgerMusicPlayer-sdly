// local:// 协议 URL 拼接工具
// 主进程与渲染进程共用，确保所有本地文件 URL 走同一套编码策略，
// 否则音频/封面/缓存/下载在 edge-case 上行为分裂。

/**
 * 把绝对文件路径转成 local:// 协议 URL。
 *
 * 编码顺序：
 * 1. \\ -> /（Windows 路径规范化）
 * 2. 按路径段 encodeURIComponent，再用 / 拼回去
 *
 * 不直接对整条路径 encodeURIComponent：它会把 / 编码成 %2F，主进程按段解码还原
 * 更可靠。按路径段编码可以保留目录分隔符，同时正确处理空格、中文、#、?、% 等特殊字符。
 *
 * 注意：local 协议刻意保持非 standard（见 main/index.ts 的 registerSchemesAsPrivileged
 * 注释），否则 Windows 盘符路径会被 Chromium 当作 host 吞掉或直接解析失败。
 *
 * 必须编码而不是裸拼：Image loader（含 crossOrigin='Anonymous' 时）对未编码空格
 * 比 audio.src 严格——封面常落到 "Application Support" 这类含空格目录会加载失败。
 *
 * 主进程 fileManager 用 decodeURIComponent 还原；它是 encodeURIComponent 的逆，
 * 能解码本函数产生的全部 %XX。
 */
export function filePathToLocalUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  return `local:///${encoded}`;
}

/**
 * 把 local:// 协议 URL 还原为绝对文件路径（fileManager 协议处理器使用）。
 *
 * 与 filePathToLocalUrl 互为逆操作（含跨平台差异），抽成共享函数以便两端复用与测试。
 * 注意：本函数只做字符串层面的解码与平台斜杠处理，不做 path.normalize（shared 目录
 * 会被渲染进程打包，不能引入 node:path）——主进程调用方自行 normalize。
 */
export function localUrlToFilePath(localUrl: string): string {
  let filePath = decodeURIComponent(localUrl.replace(/^local:\/\/\/?/, ''));

  // Windows: 协议解析后可能是 /C:/...，去掉前导斜杠
  if (/^\/[a-zA-Z]:\//.test(filePath)) {
    filePath = filePath.slice(1);
  }

  // macOS/Linux 上去掉前导斜杠后会丢失绝对路径标识，这里补回
  if (process.platform !== 'win32' && !filePath.startsWith('/')) {
    filePath = '/' + filePath;
  }

  return filePath;
}
