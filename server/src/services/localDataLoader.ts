/**
 * 本地数据加载器 - 解析1分钟K线文件并聚合为多周期
 * 支持GBK编码的通达信导出数据
 */
import * as fs from 'fs';
import * as path from 'path';
import * as iconv from 'iconv-lite';

export interface MinuteBar {
  datetime: string;   // "2022-01-11 21:24"
  date: string;       // "2022-01-11"
  time: string;       // "21:24"
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  oi: number;         // 持仓量
}

export interface KlineBar {
  date: string;
  time?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

export interface VarietyData {
  code: string;       // e.g. "AL8"
  name: string;       // e.g. "豆一主连"
  exchange: string;   // e.g. "DCE"
  bars: MinuteBar[];
}

// 品种代码映射
export const VARIETY_MAP: Record<string, { name: string; exchange: string; systemCode: string }> = {
  // 上期所 DCE
  'AL8':  { name: '豆一',   exchange: 'DCE',  systemCode: 'A0' },
  // 上期所 SHFE
  'ALL8': { name: '沪铝',   exchange: 'SHFE', systemCode: 'AL0' },
  'CUL8': { name: '沪铜',   exchange: 'SHFE', systemCode: 'CU0' },
  'NIL8': { name: '沪镍',   exchange: 'SHFE', systemCode: 'NI0' },
  'PBL8': { name: '沪铅',   exchange: 'SHFE', systemCode: 'PB0' },
  'SNL8': { name: '沪锡',   exchange: 'SHFE', systemCode: 'SN0' },
  'ZNL8': { name: '沪锌',   exchange: 'SHFE', systemCode: 'ZN0' },
  'AGL8': { name: '白银',   exchange: 'SHFE', systemCode: 'AG0' },
  'AUL8': { name: '黄金',   exchange: 'SHFE', systemCode: 'AU0' },
  'HCL8': { name: '热轧卷板', exchange: 'SHFE', systemCode: 'HC0' },
  'RBL8': { name: '螺纹钢', exchange: 'SHFE', systemCode: 'RB0' },
  'FUL8': { name: '燃油',   exchange: 'SHFE', systemCode: 'FU0' },
  'BRL8': { name: '苯乙烯', exchange: 'SHFE', systemCode: 'EB0' },
  'NRL8': { name: '20号胶', exchange: 'SHFE', systemCode: 'NR0' },
  'RUL8': { name: '橡胶',   exchange: 'SHFE', systemCode: 'RU0' },
  'SCL8': { name: '原油',   exchange: 'SHFE', systemCode: 'SC0' },
  'SPL8': { name: '纸浆SHFE', exchange: 'SHFE', systemCode: 'SP0' },
  // 大商所 DCE
  'JL8':  { name: '焦炭',   exchange: 'DCE',  systemCode: 'J0' },
  'JML8': { name: '焦煤',   exchange: 'DCE',  systemCode: 'JM0' },
  'IL8':  { name: '铁矿石', exchange: 'DCE',  systemCode: 'I0' },
  'JDL8': { name: '鸡蛋',   exchange: 'DCE',  systemCode: 'JD0' },
  'LHL8': { name: '沥青',   exchange: 'DCE',  systemCode: 'BU0' },
  'ML8':  { name: '甲醇',   exchange: 'DCE',  systemCode: 'MA0' },
  'YL8':  { name: '玉米淀粉', exchange: 'DCE', systemCode: 'CS0' },
  'CL8':  { name: '玉米',   exchange: 'DCE',  systemCode: 'C0' },
  'PPL8': { name: '聚丙烯', exchange: 'DCE',  systemCode: 'PP0' },
  'VL8':  { name: 'PVC',    exchange: 'DCE',  systemCode: 'V0' },
  'BUL8': { name: '尿素',   exchange: 'DCE',  systemCode: 'UR0' },
  'ECL8': { name: '乙二醇', exchange: 'DCE',  systemCode: 'EG0' },
  'EBL8': { name: '苯乙烯DCE', exchange: 'DCE', systemCode: 'EB0' },
  'EGL8': { name: '乙二醇DCE', exchange: 'DCE', systemCode: 'EG0' },
  'LL8':  { name: 'LLDPE',  exchange: 'DCE',  systemCode: 'L0' },
  'BL8':  { name: '豆油',   exchange: 'DCE',  systemCode: 'Y0' },
  'CSL8': { name: '玉米淀粉DCE', exchange: 'DCE', systemCode: 'CS0' },
  'BBL8': { name: '粳米',   exchange: 'DCE',  systemCode: 'RR0' },
  'BZL8': { name: '苯乙烯DCE2', exchange: 'DCE', systemCode: 'EB0' },
  'FBL8': { name: '纤维板', exchange: 'DCE',  systemCode: 'FB0' },
  'LGL8': { name: '塑料',   exchange: 'DCE',  systemCode: 'L0' },
  'PGL8': { name: '聚乙烯', exchange: 'DCE',  systemCode: 'L0' },
  'PL8':  { name: '聚乙烯DCE', exchange: 'DCE', systemCode: 'L0' },
  // 郑商所 CZCE
  'SFL8': { name: '豆粕',   exchange: 'CZCE', systemCode: 'M0' },
  'SML8': { name: '棕榈油', exchange: 'CZCE', systemCode: 'P0' },
  'OIL8': { name: '菜油',   exchange: 'CZCE', systemCode: 'OI0' },
  'RML8': { name: '菜粕',   exchange: 'CZCE', systemCode: 'RM0' },
  'FGL8': { name: '玻璃',   exchange: 'CZCE', systemCode: 'FG0' },
  'MAL8': { name: '甲醇CZCE', exchange: 'CZCE', systemCode: 'MA0' },
  'SAL8': { name: '纯碱',   exchange: 'CZCE', systemCode: 'SA0' },
  'TAL8': { name: 'PTA',    exchange: 'CZCE', systemCode: 'TA0' },
  'APL8': { name: '苹果',   exchange: 'CZCE', systemCode: 'AP0' },
  'CFL8': { name: '纸浆',   exchange: 'CZCE', systemCode: 'SP0' },
  'CJL8': { name: '红枣',   exchange: 'CZCE', systemCode: 'CJ0' },
  'CYL8': { name: '短纤CZCE', exchange: 'CZCE', systemCode: 'PF0' },
  'PKL8': { name: '花生',   exchange: 'CZCE', systemCode: 'PK0' },
  'SRL8': { name: '硅铁',   exchange: 'CZCE', systemCode: 'SF0' },
  'PFL8': { name: '纯碱CZCE', exchange: 'CZCE', systemCode: 'SA0' },
  'PLL8': { name: '短纤',   exchange: 'CZCE', systemCode: 'PF0' },
  'PRL8': { name: '花生CZCE', exchange: 'CZCE', systemCode: 'PK0' },
  'PXL8': { name: ' PX',    exchange: 'CZCE', systemCode: 'PX0' },
  'RSL8': { name: '锰硅',   exchange: 'CZCE', systemCode: 'SM0' },
  'SHL8': { name: '硅铁CZCE', exchange: 'CZCE', systemCode: 'SF0' },
  'URL8': { name: '尿素CZCE', exchange: 'CZCE', systemCode: 'UR0' },
  'RRL8': { name: '粳米DCE', exchange: 'DCE', systemCode: 'RR0' },
  'ADL8': { name: '氧化铝', exchange: 'SHFE', systemCode: 'AO0' },
  'AOL8': { name: '氧化铝DCE', exchange: 'DCE', systemCode: 'AO0' },
  'BCL8': { name: '烧碱',   exchange: 'SHFE', systemCode: 'SH0' },
  'LUL8': { name: '碳酸锂', exchange: 'CZCE', systemCode: 'LC0' },
  'OPL8': { name: '对二甲苯', exchange: 'CZCE', systemCode: 'PX0' },
  'SSL8': { name: '不锈钢', exchange: 'SHFE', systemCode: 'SS0' },
  'WRL8': { name: '线材',   exchange: 'SHFE', systemCode: 'WR0' },
};

/**
 * 将旧合约代码映射为系统品种代码
 * 例如: "JDL8" -> "JD0", "AUL8" -> "AU0", "PLL8" -> "PF0"
 * 若映射表中不存在，则原样返回
 */
export function contractToSystemCode(contractCode: string): string {
  const info = VARIETY_MAP[contractCode];
  return info?.systemCode ?? contractCode;
}

/**
 * 获取品种信息（含系统品种代码）
 * 映射表中不存在时回退为原始代码
 */
export function getVarietyInfo(contractCode: string): { name: string; exchange: string; systemCode: string } {
  return VARIETY_MAP[contractCode] ?? { name: contractCode, exchange: 'UNKNOWN', systemCode: contractCode };
}

const DATA_DIR = path.resolve(process.cwd(), '../assets');

/**
 * 解析单个数据文件
 */
export function parseDataFile(filePath: string): VarietyData | null {
  try {
    const buffer = fs.readFileSync(filePath);
    const content = iconv.decode(buffer, 'gbk');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length < 3) return null;

    // 解析头部: "AL8 豆一主连 1分钟线 前复权"
    const headerParts = lines[0].split(/\s+/);
    const code = headerParts[0];
    const name = headerParts[1] || code;

    const bars: MinuteBar[] = [];

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      // 数据行格式: "20220111\t2124\t5801\t5803\t5797\t5797\t597\t160822\t0"
      if (!/^\d{8}\t/.test(line) && !/^\d{8}\s+/.test(line)) continue;

      const parts = line.split(/[\t\s]+/);
      if (parts.length < 7) continue;

      const dateStr = parts[0]; // "20220111"
      const timeStr = parts[1]; // "2124"

      if (dateStr.length !== 8 || !/^\d+$/.test(dateStr)) continue;

      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const hour = timeStr.padStart(4, '0').substring(0, 2);
      const minute = timeStr.padStart(4, '0').substring(2, 4);

      const date = `${year}-${month}-${day}`;
      const time = `${hour}:${minute}`;

      bars.push({
        datetime: `${date} ${time}`,
        date,
        time,
        o: parseFloat(parts[2]),
        h: parseFloat(parts[3]),
        l: parseFloat(parts[4]),
        c: parseFloat(parts[5]),
        vol: parseFloat(parts[6]),
        oi: parts.length > 7 ? parseFloat(parts[7]) : 0,
      });
    }

    const varietyInfo = VARIETY_MAP[code] || { name, exchange: 'UNKNOWN', systemCode: code };

    return {
      code,
      name: varietyInfo.name,
      exchange: varietyInfo.exchange,
      bars,
    };
  } catch (err) {
    console.error(`解析文件失败 ${filePath}:`, err);
    return null;
  }
}

/**
 * 加载所有本地数据文件
 * 支持多部分文件合并（如 AGL8-1.txt + AGL8-2.txt）
 * 跳过重复文件（文件名包含"副本"）
 */
export function loadAllLocalData(): VarietyData[] {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
  
  // 按品种代码分组，处理多部分文件
  const fileGroups: Record<string, string[]> = {};
  
  for (const file of files) {
    // 跳过"副本"文件（重复文件）
    if (file.includes('副本')) continue;
    
    // 提取品种代码：从文件名中提取，如 "30#AGL8 - 1.txt" -> "AGL8"
    // 支持带时间戳的文件名，如 "28#FGL8_20260704201510854.txt"
    // 支持带横杠的文件名，如 "29#V-FL8.txt"
    const match = file.match(/#([A-Z]+-?[A-Z]*L8)/);
    if (!match) continue;
    const code = match[1];
    
    if (!fileGroups[code]) {
      fileGroups[code] = [];
    }
    fileGroups[code].push(file);
  }
  
  const results: VarietyData[] = [];
  
  for (const [code, groupFiles] of Object.entries(fileGroups)) {
    // 按文件名排序，确保合并顺序正确
    groupFiles.sort();
    
    let allBars: MinuteBar[] = [];
    let varietyName = code;
    let exchange = 'UNKNOWN';
    
    for (const file of groupFiles) {
      const filePath = path.join(DATA_DIR, file);
      const data = parseDataFile(filePath);
      if (data && data.bars.length > 0) {
        allBars = allBars.concat(data.bars);
        varietyName = data.name;
        exchange = data.exchange;
      }
    }
    
    // 按日期时间排序并去重
    allBars.sort((a, b) => a.datetime.localeCompare(b.datetime));
    const uniqueBars: MinuteBar[] = [];
    const seen = new Set<string>();
    for (const bar of allBars) {
      if (!seen.has(bar.datetime)) {
        seen.add(bar.datetime);
        uniqueBars.push(bar);
      }
    }
    
    if (uniqueBars.length > 100) {
      console.log(`✅ ${code} (${varietyName}): ${uniqueBars.length} bars, ${uniqueBars[0].date} ~ ${uniqueBars[uniqueBars.length - 1].date}`);
      results.push({
        code,
        name: varietyName,
        exchange,
        bars: uniqueBars,
      });
    }
  }
  
  return results;
}

/**
 * 将1分钟K线聚合为指定周期
 * @param bars 1分钟K线数组
 * @param minutes 聚合分钟数 (5, 15, 30, 60)
 */
export function aggregateToTimeframe(bars: MinuteBar[], minutes: number): KlineBar[] {
  if (bars.length === 0) return [];

  const result: KlineBar[] = [];
  let currentBar: KlineBar | null = null;
  let barIndex = 0;

  for (const bar of bars) {
    // 计算当前bar属于哪个时间窗口
    const [hour, min] = bar.time.split(':').map(Number);
    const totalMinutes = hour * 60 + min;
    const windowStart = Math.floor(totalMinutes / minutes) * minutes;

    // 对于跨日的情况，使用日期+时间窗口作为分组key
    const windowKey = `${bar.date}_${windowStart}`;

    if (!currentBar || (currentBar as any)._key !== windowKey) {
      // 保存前一个bar
      if (currentBar) {
        result.push({ ...currentBar });
      }
      // 开始新bar
      currentBar = {
        date: bar.date,
        time: `${String(Math.floor(windowStart / 60)).padStart(2, '0')}:${String(windowStart % 60).padStart(2, '0')}`,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        vol: bar.vol,
      };
      (currentBar as any)._key = windowKey;
    } else {
      // 更新当前bar
      currentBar.h = Math.max(currentBar.h, bar.h);
      currentBar.l = Math.min(currentBar.l, bar.l);
      currentBar.c = bar.c;
      currentBar.vol += bar.vol;
    }
  }

  // 保存最后一个bar
  if (currentBar) {
    result.push({ ...currentBar });
  }

  return result;
}

/**
 * 将1分钟K线聚合为日线
 */
export function aggregateToDaily(bars: MinuteBar[]): KlineBar[] {
  if (bars.length === 0) return [];

  const result: KlineBar[] = [];
  let currentBar: KlineBar | null = null;

  for (const bar of bars) {
    if (!currentBar || currentBar.date !== bar.date) {
      if (currentBar) {
        result.push({ ...currentBar });
      }
      currentBar = {
        date: bar.date,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        vol: bar.vol,
      };
    } else {
      currentBar.h = Math.max(currentBar.h, bar.h);
      currentBar.l = Math.min(currentBar.l, bar.l);
      currentBar.c = bar.c;
      currentBar.vol += bar.vol;
    }
  }

  if (currentBar) {
    result.push({ ...currentBar });
  }

  return result;
}

/**
 * 获取所有周期的数据
 */
export function getAllTimeframeData(bars: MinuteBar[]): Record<string, KlineBar[]> {
  return {
    '1m': bars.map(b => ({ date: b.date, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol })),
    '5m': aggregateToTimeframe(bars, 5),
    '15m': aggregateToTimeframe(bars, 15),
    '30m': aggregateToTimeframe(bars, 30),
    '60m': aggregateToTimeframe(bars, 60),
    'daily': aggregateToDaily(bars),
  };
}
