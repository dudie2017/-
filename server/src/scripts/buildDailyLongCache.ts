/**
 * 构建10品种全量日线缓存（用于对照回测）
 * 从新浪拉取全量日线（不截断），保存到 data-cache-daily-long/
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchDaily } from '../services/dataFetcher.js';

const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];
const OUT_DIR = path.resolve(process.cwd(), 'data-cache-daily-long');

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const code of CODES) {
    const bars = await fetchDaily(code, 100000); // 拉全量
    if (!bars || bars.length < 500) {
      console.log(`${code}: 数据不足 (${bars?.length ?? 0})`);
      continue;
    }
    const payload = { bars, contract: code, timestamp: Date.now() };
    fs.writeFileSync(path.join(OUT_DIR, `${code}.json`), JSON.stringify(payload));
    const first = bars[0].date;
    const last = bars[bars.length - 1].date;
    console.log(`${code}: ${bars.length}根, ${first} ~ ${last} (${Math.round(bars.length / 250)}年)`);
  }
  console.log('完成');
}

main().catch((e) => console.error(e));
