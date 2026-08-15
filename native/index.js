// bp-output 原生模块入口
// 开发环境：native/build/Release/bp_output.node（node-gyp / electron-rebuild 产物）
// 打包环境：electron-builder 通过 asarUnpack 将 .node 解包到 app.asar.unpacked，
//           Electron 对 .node 的 require 会自动重定向到解包路径。
module.exports = require('./build/Release/bp_output.node');
