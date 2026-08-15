// CUE 分轨解析 + 渲染层 CUE 路径/可见性工具 单元测试
//
// 用 esbuild 把真实 TS 源码打包为 CJS 后 require，确保测试的是生产代码
// （项目未装 bun/ts-node，esbuild 随 vite 依赖可用）。
// 运行：npm run test:cue-sheet

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const tmpDir = path.join(__dirname, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

function bundleTo(entry, outfile, alias = {}) {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', '..', entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: path.join(tmpDir, outfile),
    alias
  });
  return require(path.join(tmpDir, outfile));
}

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${extra ? ` | ${extra}` : ''}`);
  }
}

function approx(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

// ==================== 一、CUE 解析器（src/shared/cueSheet.ts） ====================
const { cueTimeToSeconds, parseCueSheet } = bundleTo('src/shared/cueSheet.ts', 'cueSheet.cjs');

// ---------- 时间格式（实现指南 7.1） ----------
check('time: 00:03:25 = 3.333s', approx(cueTimeToSeconds('00:03:25'), 3 + 25 / 75));
check('time: 42:15:60 = 2535.8s', approx(cueTimeToSeconds('42:15:60'), 2535 + 60 / 75));
check('time: 03:25 invalid (需 MM:SS:FF 三部分)', cueTimeToSeconds('03:25') === 0);
check('time: 00:00:00 = 0s', cueTimeToSeconds('00:00:00') === 0);
check('time: 01:02:03.500 = 62.54s', approx(cueTimeToSeconds('01:02:03.500'), 60 + 2 + 3 / 75 + 0.5));
check('time: invalid returns 0', cueTimeToSeconds('abc') === 0 && cueTimeToSeconds('') === 0);

// ---------- 整轨 CUE（实现指南 7.4） ----------
const wholeTrack = `TITLE "陈瑞精选集"
PERFORMER "陈瑞"
FILE "陈瑞-剪爱.wav" WAVE
  TRACK 01 AUDIO
    TITLE "剪爱"
    PERFORMER "陈瑞"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "白狐"
    INDEX 01 03:45:00
  TRACK 03 AUDIO
    TITLE "女人心"
    INDEX 01 07:15:00
  TRACK 04 AUDIO
    TITLE "最后的歌"
    INDEX 01 12:05:00`;

const ws = parseCueSheet(wholeTrack);
check('whole-track: parsed', !!ws);
if (ws) {
  check('whole-track: albumTitle', ws.albumTitle === '陈瑞精选集');
  check('whole-track: albumArtist', ws.albumArtist === '陈瑞');
  check('whole-track: isMultiFile=false', ws.isMultiFile === false);
  check('whole-track: 4 tracks', ws.tracks.length === 4);
  check('whole-track: audioFile resolved', ws.tracks[0].audioFile === '陈瑞-剪爱.wav');
  check('whole-track: track1 offset=0', ws.tracks[0].offset === 0);
  check('whole-track: track2 offset=225', approx(ws.tracks[1].offset, 225));
  check('whole-track: track1 duration=225', approx(ws.tracks[0].duration, 225));
  check('whole-track: track2 duration=210', approx(ws.tracks[1].duration, 210));
  check('whole-track: track3 duration=290', approx(ws.tracks[2].duration, 290));
  check('whole-track: last track duration=0', ws.tracks[3].duration === 0);
  check(
    'whole-track: track-level TITLE',
    ws.tracks[0].title === '剪爱' && ws.tracks[1].title === '白狐'
  );
  check(
    'whole-track: track-level PERFORMER',
    ws.tracks[0].artist === '陈瑞' && ws.tracks[1].artist === ''
  );
  check('whole-track: index starts at 1', ws.tracks[0].index === 1 && ws.tracks[3].index === 4);
}

// ---------- 多文件 CUE（实现指南 7.4） ----------
const multiFile = `TITLE "多文件专辑"
FILE "01.wav" WAVE
  TRACK 01 AUDIO
    TITLE "第一首"
    INDEX 01 00:00:00
FILE "02.wav" WAVE
  TRACK 02 AUDIO
    TITLE "第二首"
    INDEX 01 00:00:00`;

const ms = parseCueSheet(multiFile);
check('multi-file: parsed', !!ms);
if (ms) {
  check('multi-file: isMultiFile=true', ms.isMultiFile === true);
  check('multi-file: durations=0', ms.tracks[0].duration === 0 && ms.tracks[1].duration === 0);
  check(
    'multi-file: per-track audioFile',
    ms.tracks[0].audioFile === '01.wav' && ms.tracks[1].audioFile === '02.wav'
  );
}

// ---------- INDEX 00 忽略 / 无引号 FILE / 空 CUE ----------
const pregap = `FILE album.wav WAVE
  TRACK 01 AUDIO
    TITLE "带前置间隙"
    INDEX 00 00:00:00
    INDEX 01 00:02:00
  TRACK 02 AUDIO
    TITLE "第二轨"
    INDEX 01 03:00:00`;

const pg = parseCueSheet(pregap);
check('pregap: parsed', !!pg);
if (pg) {
  check('pregap: INDEX 00 ignored (offset=2s)', approx(pg.tracks[0].offset, 2));
  check('pregap: unquoted FILE', pg.tracks[0].audioFile === 'album.wav');
  check('pregap: track1 duration=178', approx(pg.tracks[0].duration, 178));
}

check('empty cue -> null', parseCueSheet('REM 注释\n没有 TRACK\n') === null);
check('null/empty input -> null', parseCueSheet('') === null);

// ---------- 单曲 CUE 也是子轨（实现指南 7.5：cueIndex > 0 即 CUE 子轨） ----------
const single = `TITLE "单曲专辑"
PERFORMER "歌手"
FILE "song.wav" WAVE
  TRACK 01 AUDIO
    TITLE "唯一的歌"
    INDEX 01 00:00:00`;

const ss = parseCueSheet(single);
check('single-track cue: parsed', !!ss);
if (ss) {
  check('single-track cue: track index=1 (>0 即子轨)', ss.tracks[0].index === 1);
  check('single-track cue: offset=0', ss.tracks[0].offset === 0);
  check('single-track cue: duration=0 (需音频时长补)', ss.tracks[0].duration === 0);
}

// ==================== 二、渲染层 CUE 路径/可见性工具（src/renderer/utils/localMusicUtils.ts） ====================
const {
  dirnameOfPath,
  resolveCueAudioPath,
  cueFileBaseName,
  filterCueCoveredEntries,
  matchSidecarLrcByName
} = bundleTo('src/renderer/utils/localMusicUtils.ts', 'localMusicUtils.cjs', {
  '@': path.join(__dirname, '..', '..', 'src', 'renderer')
});

const WIN_CUE = 'D:\\music\\album\\a.cue';
const POSIX_CUE = '/mnt/music/album/a.cue';

check('dirname: win', dirnameOfPath(WIN_CUE) === 'D:\\music\\album');
check('dirname: posix', dirnameOfPath(POSIX_CUE) === '/mnt/music/album');
check(
  'resolve: relative win',
  resolveCueAudioPath('D:\\music\\album', 'album.wav') === 'D:\\music\\album\\album.wav'
);
check(
  'resolve: absolute win',
  resolveCueAudioPath('D:\\music\\album', 'E:\\other\\x.wav') === 'E:\\other\\x.wav'
);
check(
  'resolve: relative posix',
  resolveCueAudioPath('/mnt/music', 'song.flac') === '/mnt/music/song.flac'
);
check(
  'resolve: slash normalize',
  resolveCueAudioPath('D:\\music', 'sub/01.wav') === 'D:\\music\\sub\\01.wav'
);
check('cueBaseName: win', cueFileBaseName(WIN_CUE) === 'a');
check('cueBaseName: chinese', cueFileBaseName('D:\\music\\陈瑞精选集.cue') === '陈瑞精选集');

// 可见性过滤（实现指南 7.6 去重：被 CUE 引用的音频文件不单独展示）
const entries = [
  { id: 'a', filePath: 'D:\\x\\album.wav', title: 'album' },
  { id: 'b', filePath: 'D:\\x\\album.wav', title: 't1', cueIndex: 1, cueFrom: 'D:\\x\\album.wav' },
  { id: 'c', filePath: 'D:\\x\\album.wav', title: 't2', cueIndex: 2, cueFrom: 'D:\\x\\album.wav' },
  { id: 'd', filePath: 'D:\\x\\standalone.mp3', title: 'solo' }
];
const filtered = filterCueCoveredEntries(entries);
check('dedup: audio covered by cue hidden', !filtered.some((e) => e.id === 'a'));
check('dedup: cue tracks kept', filtered.filter((e) => e.cueIndex).length === 2);
check('dedup: standalone kept', filtered.some((e) => e.id === 'd'));

// ==================== 三、旁挂歌词“文件名包含标题”匹配 ====================
// 匹配规则：精确同名（去扩展名）优先；否则取包含标题的最短文件名；
// 文件名可含歌手前缀（“陈瑞-剪爱.lrc”匹配标题“剪爱”）
check(
  'lrc: 精确同名命中',
  matchSidecarLrcByName(['剪爱.lrc', '白狐.lrc'], '剪爱') === '剪爱.lrc'
);
check(
  'lrc: 歌手前缀包含命中',
  matchSidecarLrcByName(['陈瑞-剪爱.lrc', '白狐.lrc'], '剪爱') === '陈瑞-剪爱.lrc'
);
check(
  'lrc: 最短包含优先（避免合集误命中）',
  matchSidecarLrcByName(['陈瑞精选合集.lrc', '陈瑞-剪爱.lrc'], '剪爱') === '陈瑞-剪爱.lrc'
);
check(
  'lrc: 不区分大小写',
  matchSidecarLrcByName(['CHEN-JIAN-AI.LRC'], 'jian-ai') === 'CHEN-JIAN-AI.LRC' &&
    matchSidecarLrcByName(['JIAN-AI.lrc'], 'JIAN-AI') === 'JIAN-AI.lrc'
);
check('lrc: 无标题返回 null', matchSidecarLrcByName(['剪爱.lrc'], '') === null);
check('lrc: 无 .lrc 文件返回 null', matchSidecarLrcByName(['剪爱.mp3'], '剪爱') === null);
check('lrc: 无匹配返回 null', matchSidecarLrcByName(['白狐.lrc'], '剪爱') === null);
check(
  'lrc: 单字标题不做包含匹配（避免误伤）',
  matchSidecarLrcByName(['爱的路上千万里.lrc', '梦回大唐.lrc'], '爱') === null &&
    matchSidecarLrcByName(['爱.lrc'], '爱') === '爱.lrc'
);
check(
  'lrc: 非 lrc 文件不影响匹配',
  matchSidecarLrcByName(['白狐.lrc', '剪爱.txt', '陈瑞-剪爱.lrc'], '剪爱') === '陈瑞-剪爱.lrc'
);

// ==================== 总结 ====================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
