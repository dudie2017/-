import { scanV16Variety } from '../services/v16_engine';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const code = 'AG0';
  const fp = path.join('data-cache-daily-20y', `${code}.json`);
  const bars = JSON.parse(fs.readFileSync(fp, 'utf8'));
  console.log('bars:', bars.length);
  const warmup = 60;
  const start = Date.now();
  let cnt = 0;
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    await scanV16Variety(code, histBars, code, { edgeLookback: 70, allowRangeTrading: true });
    cnt++;
  }
  const elapsed = Date.now() - start;
  console.log(`预扫描 ${cnt} 根bar 耗时: ${elapsed}ms, 平均 ${(elapsed/cnt).toFixed(2)}ms/bar`);
}

main().catch(e => { console.error(e); process.exit(1); });
