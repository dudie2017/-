/**
 * 阶段一：构建 20 年日线主连数据缓存
 * 拉取 56 品种 Tushare 主连日线（2000 年至今），落盘 data-cache-daily-20y/{code}.json
 *
 * 运行：cd server && TUSHARE_TOKEN=xxx npx tsx src/scripts/buildDaily20yCache.ts
 * 说明：TUSHARE_TOKEN 从 .env 读取（脚本内自行加载）
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ===== 配置 =====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(SERVER_ROOT, 'data-cache-daily-20y');
const TUSHARE_API_URL = 'https://api.tushare.pro';

// 读取 .env 中的 token
function loadToken(): string {
  const envPath = path.join(SERVER_ROOT, '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^TUSHARE_TOKEN\s*=\s*["']?([^"'\n]+)["']?$/m);
  if (!match) {
    console.error('[FATAL] .env 中未找到 TUSHARE_TOKEN');
    process.exit(1);
  }
  return match[1].trim();
}
const TUSHARE_TOKEN = loadToken();

// 品种代码(CU0) -> Tushare 主连 ts_code(CU.SHF)
const TS_CODE_MAP: Record<string, string> = {
  // ===== 上期所 SHF =====
  CU0: 'CU.SHF', AL0: 'AL.SHF', ZN0: 'ZN.SHF', NI0: 'NI.SHF',
  AG0: 'AG.SHF', AU0: 'AU.SHF', HC0: 'HC.SHF', RB0: 'RB.SHF',
  SP0: 'SP.SHF', FU0: 'FU.SHF', BU0: 'BU.SHF', AO0: 'AO.SHF',
  SS0: 'SS.SHF', PB0: 'PB.SHF', RU0: 'RU.SHF', WR0: 'WR.SHF',
  // ===== 上期能源 INE =====
  SC0: 'SC.INE', LU0: 'LU.INE', BC0: 'BC.INE', EC0: 'EC.INE', NR0: 'NR.INE',
  // ===== 大商所 DCE =====
  I0: 'I.DCE', JM0: 'JM.DCE', J0: 'J.DCE', P0: 'P.DCE', M0: 'M.DCE',
  A0: 'A.DCE', LH0: 'LH.DCE', JD0: 'JD.DCE', L0: 'L.DCE', PP0: 'PP.DCE',
  EB0: 'EB.DCE', PG0: 'PG.DCE', EG0: 'EG.DCE', C0: 'C.DCE', Y0: 'Y.DCE',
  V0: 'V.DCE',
  // ===== 郑商所 ZCE =====
  AP0: 'AP.ZCE', CF0: 'CF.ZCE', SA0: 'SA.ZCE', FG0: 'FG.ZCE',
  WH0: 'WH.ZCE', PM0: 'PM.ZCE',
  TA0: 'TA.ZCE', MA0: 'MA.ZCE', RM0: 'RM.ZCE', CJ0: 'CJ.ZCE',
  SF0: 'SF.ZCE', SM0: 'SM.ZCE', UR0: 'UR.ZCE', PX0: 'PX.ZCE',
  OI0: 'OI.ZCE', SR0: 'SR.ZCE', ZC0: 'ZC.ZCE',
  // ===== 中金所 CFX =====
  IM0: 'IM.CFX', IF0: 'IF.CFX', IH0: 'IH.CFX', IC0: 'IC.CFX',
  T0: 'T.CFX', TF0: 'TF.CFX',
  // ===== 广期所 GFE =====
  SI0: 'SI.GFE', LC0: 'LC.GFE',
};

// 分页时间段（每 5 年一段，单段 < 2000 条交易记录，规避 fut_daily 单次上限）
const DATE_RANGES: Array<[string, string]> = [
  ['20000101', '20041231'],
  ['20050101', '20091231'],
  ['20100101', '20141231'],
  ['20150101', '20191231'],
  ['20200101', '20241231'],
  ['20250101', '20261231'],
];

const FIELDS = 'ts_code,trade_date,open,high,low,close,vol,oi';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 拉取一段历史日线，失败自动重试 2 次
async function fetchDaily(tsCode: string, startDate: string, endDate: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.post(
        TUSHARE_API_URL,
        {
          api_name: 'fut_daily',
          token: TUSHARE_TOKEN,
          params: { ts_code: tsCode, start_date: startDate, end_date: endDate },
          fields: FIELDS,
        },
        { timeout: 30000 }
      );
      if (resp.data?.code !== 0) {
        console.error(`[${tsCode}] ${startDate}~${endDate} API错误(尝试${attempt + 1}):`, resp.data?.msg);
      } else {
        return resp.data.data?.items || [];
      }
    } catch (e) {
      console.error(`[${tsCode}] ${startDate}~${endDate} 网络错误(尝试${attempt + 1}):`, (e as Error).message);
    }
    await sleep(2000 * (attempt + 1));
  }
  return [];
}

// YYYYMMDD -> YYYY-MM-DD
function fmtDate(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const codes = Object.keys(TS_CODE_MAP);
  console.log(`[START] 共 ${codes.length} 个品种，目标目录 ${OUT_DIR}`);

  let totalBars = 0;
  const stats: Array<{ code: string; tsCode: string; count: number; range: string }> = [];

  for (const code of codes) {
    const tsCode = TS_CODE_MAP[code];
    const outFile = path.join(OUT_DIR, `${code}.json`);

    // 增量模式：已存在且非空的文件跳过（用于修正映射后补拉）
    if (fs.existsSync(outFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        if (Array.isArray(existing) && existing.length > 0) {
          console.log(`[SKIP] ${code} (${tsCode}): 已有 ${existing.length} 条, 跳过`);
          continue;
        }
      } catch {
        // 文件损坏则重拉
      }
    }

    const barMap = new Map<string, Record<string, unknown>>();

    for (const [start, end] of DATE_RANGES) {
      const rows = (await fetchDaily(tsCode, start, end)) as unknown[][];
      for (const r of rows) {
        // r: [ts_code, trade_date, open, high, low, close, vol, oi]
        const date = fmtDate(String(r[1]));
        barMap.set(date, {
          date,
          o: r[2],
          h: r[3],
          l: r[4],
          c: r[5],
          vol: r[6] ?? 0,
          hold: r[7] ?? 0,
        });
      }
      await sleep(180); // 限频保护
    }

    const list = [...barMap.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );
    fs.writeFileSync(path.join(OUT_DIR, `${code}.json`), JSON.stringify(list));

    const range = list.length
      ? `${String(list[0].date)} ~ ${String(list[list.length - 1].date)}`
      : '空';
    totalBars += list.length;
    stats.push({ code, tsCode, count: list.length, range });
    console.log(`[OK] ${code} (${tsCode}): ${list.length} 条, ${range}`);
  }

  console.log('\n===== 汇总 =====');
  console.log(`总条数: ${totalBars}`);
  console.log('覆盖率:');
  for (const s of stats) {
    const years = s.count / 250;
    console.log(`  ${s.code} (${s.tsCode}): ${s.count} 条 (~${years.toFixed(1)}年) ${s.range}`);
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
