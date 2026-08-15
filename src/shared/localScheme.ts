// local:// 协议的 scheme 名与特权配置
// 独立成共享模块：主进程注册（main/index.ts）与回归测试（tests/local-protocol）共用同一份配置，
// 防止将来有人误加回 standard: true 或改动其他关键特权而测试无感知。
//
// 注意：绝对不能加 standard: true。Windows 盘符路径会生成 local:///E:/xxx 形式的 URL，
// 一旦注册为 standard scheme，Chromium 会把首段 E: 当作 host 吞掉（local://e/xxx）导致
// 404；而 %3A 编码形式（local:///E%3A/xxx）则直接 Failed to parse URL / 被媒体安全
// 检查拒绝。保持非 standard（opaque URL）时 request.url 原样透传，配合
// localUrlToFilePath 的 decodeURIComponent 即可正确还原盘符路径。
export const LOCAL_SCHEME = 'local';

export const LOCAL_SCHEME_PRIVILEGES = {
  secure: true,
  supportFetchAPI: true,
  stream: true,
  bypassCSP: true,
  corsEnabled: true
} as const;
