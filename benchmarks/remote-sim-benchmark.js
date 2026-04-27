#!/usr/bin/env node
const os = require('os');

console.log(JSON.stringify({
  scenario: 'remote-sim',
  host: os.hostname(),
  startedAt: new Date().toISOString(),
  checklist: [
    '通过 VS Code Remote/SSH 打开目标数据集',
    '记录 preview first visible 时间',
    '记录 interactive slice ready 时间',
    '连续切换 10-20 张图并记录第 1/5/10/20 张耗时',
    '采集 window.__niftiPerf 和扩展宿主 RSS/heap',
  ],
}, null, 2));

