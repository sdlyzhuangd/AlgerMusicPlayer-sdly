// bp_output 原生模块端到端测试
const bp = require('./build/Release/bp_output.node');
const path = process.argv[2] || 'E:\\迅雷云盘\\111\\姚璎格 - 倩影.flac';

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
}

async function main() {
  // 1. 事件回调
  let events = [];
  bp.setEventCallback((ev) => events.push(ev));

  // 2. open（独占模式）
  const openRes = bp.open({ path, exclusive: true });
  check('open', openRes.success, 'raw=' + JSON.stringify(openRes));
  if (!openRes.success) { console.log(results.join('\n')); process.exit(1); }

  // 3. 设备列表（open 后 context 已初始化）
  const devs = bp.listDevices();
  check('listDevices', devs.length > 0, `count=${devs.length} default=${devs.find(d => d.isDefault)?.name}`);

  // 4. play
  check('play', bp.play() === true);
  await new Promise(r => setTimeout(r, 1500));

  // 5. getPosition（应前进）
  const p1 = bp.getPosition();
  await new Promise(r => setTimeout(r, 1000));
  const p2 = bp.getPosition();
  check('progress advancing', p2.seconds > p1.seconds, `${p1.seconds.toFixed(1)} -> ${p2.seconds.toFixed(1)}`);

  // 6. seek 到 30s
  check('seek', bp.seek(30) === true);
  await new Promise(r => setTimeout(r, 800));
  const p3 = bp.getPosition();
  check('seek landed', p3.seconds > 29 && p3.seconds < 32, `pos=${p3.seconds.toFixed(1)}`);

  // 7. pause
  check('pause', bp.pause() === true);
  const p4 = bp.getPosition();
  await new Promise(r => setTimeout(r, 600));
  const p5 = bp.getPosition();
  check('paused holds', Math.abs(p5.seconds - p4.seconds) < 0.3, `${p4.seconds.toFixed(2)} -> ${p5.seconds.toFixed(2)}`);

  // 8. resume
  check('resume', bp.play() === true);
  await new Promise(r => setTimeout(r, 600));
  const p6 = bp.getPosition();
  check('resumed advancing', p6.seconds > p5.seconds, `${p5.seconds.toFixed(1)} -> ${p6.seconds.toFixed(1)}`);

  // 9. 进度事件应有（progress/end）
  await new Promise(r => setTimeout(r, 2500));
  const types = [...new Set(events.map(e => e.type))];
  check('events received', events.length > 0, `types=[${types.join(',')}] count=${events.length}`);

  // 10. close
  check('close', bp.close() === true);
  const pos = bp.getPosition();
  check('closed inactive', pos.active === false);

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
