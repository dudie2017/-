/**
 * 构建70品种全量日线缓存（用于全品种回测）
 * 包括：白名单40个 + 第一批剔除7个 + 第二批剔除8个 + 国债4个 + 其他常见11个
 * 从新浪拉取全量日线（不截断），保存到 data-cache-all70/
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchDaily } from '../services/dataFetcher.js';

const CODES = [
  // ===== 白名单 40 =====
  // 上期所
  'CU0', 'AL0', 'ZN0', 'NI0', 'AG0', 'HC0', 'SP0', 'FU0', 'BU0', 'AO0',
  // 上期能源
  'SC0', 'LU0', 'BC0', 'EC0',
  // 大商所
  'I0', 'JM0', 'J0', 'P0', 'LH0', 'JD0', 'L0', 'PP0', 'EB0', 'PG0',
  // 郑商所
  'AP0', 'SA0', 'FG0', 'TA0', 'EG0', 'MA0', 'RM0', 'CJ0', 'SF0', 'SM0', 'PF0', 'PX0', 'SH0',
  // 中金所
  'IM0',
  // 广期所
  'SI0', 'LC0',
  // ===== 第一批剔除 7 =====
  'SN0', 'SS0', 'RU0', 'RB0', 'WR0', 'PB0', 'NR0',
  // ===== 第二批剔除 8 =====
  'IF0', 'IH0', 'IC0', 'AU0', 'CF0', 'A0', 'M0', 'UR0',
  // ===== 国债全家桶 4 =====
  'T0', 'TF0', 'TS0', 'TL0',
  // ===== 其他常见 11 =====
  'SR0', 'C0', 'CS0', 'B0', 'V0', 'OI0', 'PK0', 'CY0', 'ZC0', 'RR0', 'WH0',
];
const OUT_DIR = path.resolve(process.cwd(), 'data-cache-all70');

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const failures: string[] = [];
  for (const code of CODES) {
    try {
      const bars = await fetchDaily(code, 100000); // 拉全量
      if (!bars || bars.length < 100) {
        console.log(`${code}: 数据不足 (${bars?.length ?? 0})`);
        failures.push(code);
        continue;
      }
      const payload = { bars, contract: code, timestamp: Date.now() };
      fs.writeFileSync(path.join(OUT_DIR, `${code}.json`), JSON.stringify(payload));
      const first = bars[0].date;
      const last = bars[bars.length - 1].date;
      const years = Math.round(bars.length / 250);
      console.log(`${code}: ${bars.length}根, ${first} ~ ${last} (~${years}年)`);
    } catch (e: any) {
      console.log(`${code}: 拉取失败 (${e?.message || e})`);
      failures.push(code);
    }
  }
  console.log(`\n完成，失败: ${failures.length > 0 ? failures.join(', ') : '无'}`);
}

main().catch((e) => console.error(e));
