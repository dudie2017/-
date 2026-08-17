/**
 * 构建换月日期缓存
 * 用 Tushare fut_mapping 接口识别每个品种的主力合约切换日（换月日）
 * 落盘 data-cache-daily-20y/{code}_rollover.json
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(SERVER_ROOT, 'data-cache-daily-20y');
const TUSHARE_API_URL = 'https://api.tushare.pro';

function loadToken(): string {
  const envPath = path.join(SERVER_ROOT, '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^TUSHARE_TOKEN\s*=\s*["']?([^"'\n]+)["']?$/m);
  if (!match) throw new Error('未找到 TUSHARE_TOKEN');
  return match[1].trim();
}
const TUSHARE_TOKEN = loadToken();

const TS_CODE_MAP: Record<string, string> = {
  CU0: 'CU.SHF', AL0: 'AL.SHF', ZN0: 'ZN.SHF', NI0: 'NI.SHF',
  AG0: 'AG.SHF', AU0: 'AU.SHF', HC0: 'HC.SHF', RB0: 'RB.SHF',
  SP0: 'SP.SHF', PB0: 'PB.SHF', RU0: 'RU.SHF',
  SC0: 'SC.INE',
  I0: 'I.DCE', JM0: 'JM.DCE', J0: 'J.DCE', P0: 'P.DCE', M0: 'M.DCE',
  LH0: 'LH.DCE', Y0: 'Y.DCE',
  AP0: 'AP.ZCE', CF0: 'CF.ZCE', TA0: 'TA.ZCE',
  IM0: 'IM.CFX', IF0: 'IF.CFX', IH0: 'IH.CFX', IC0: 'IC.CFX',
  SI0: 'SI.GFE',
};

// 只处理当前 26 个回测品种
const BACKTEST_CODES = [
  'SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0',
  'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0', 'SI0',
  'IC0', 'IF0', 'IH0', 'IM0', 'HC0', 'NI0', 'PB0', 'ZN0', 'SP0'
];

const FIELDS = 'ts_code,trade_date,mapping_ts_code';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMapping(tsCode: string, startDate: string, endDate: string): Promise<any[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await axios.post(
        TUSHARE_API_URL,
        {
          api_name: 'fut_mapping',
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

// 分页时间段（每5年一段，避免5000条上限）
const DATE_RANGES: Array<[string, string]> = [
  ['20000101', '20041231'],
  ['20050101', '20091231'],
  ['20100101', '20141231'],
  ['20150101', '20191231'],
  ['20200101', '20241231'],
  ['20250101', '20261231'],
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[START] 构建 ${BACKTEST_CODES.length} 个品种的换月缓存`);

  for (const code of BACKTEST_CODES) {
    const tsCode = TS_CODE_MAP[code];
    if (!tsCode) {
      console.log(`[SKIP] ${code}: 无 Tushare 映射`);
      continue;
    }

    // 拉取所有时间段
    const allRows: Array<[string, string, string]> = []; // [ts_code, trade_date, mapping_ts_code]
    for (const [start, end] of DATE_RANGES) {
      const rows = await fetchMapping(tsCode, start, end);
      allRows.push(...rows);
      await sleep(300); // 避免限流
    }

    if (allRows.length === 0) {
      console.log(`[EMPTY] ${code}: 无映射数据`);
      continue;
    }

    // 按日期升序排序（trade_date 是第二个字段）
    allRows.sort((a, b) => a[1].localeCompare(b[1]));

    // 识别换月日：mapping_ts_code 从前一日变化
    const rolloverDates: Array<{ date: string; from: string; to: string }> = [];
    for (let i = 1; i < allRows.length; i++) {
      const prevContract = allRows[i - 1][2];
      const curContract = allRows[i][2];
      if (prevContract !== curContract) {
        const date = `${allRows[i][1].slice(0, 4)}-${allRows[i][1].slice(4, 6)}-${allRows[i][1].slice(6, 8)}`;
        rolloverDates.push({
          date,
          from: prevContract,
          to: curContract,
        });
      }
    }

    // 落盘
    const outFile = path.join(OUT_DIR, `${code}_rollover.json`);
    const output = {
      code,
      tsCode,
      generatedAt: new Date().toISOString(),
      rolloverCount: rolloverDates.length,
      rollovers: rolloverDates,
    };
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`[OK] ${code}: ${rolloverDates.length} 次换月 -> ${code}_rollover.json`);
  }

  console.log('[DONE] 换月缓存构建完成');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
