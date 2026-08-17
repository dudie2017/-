import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 全品种池（经V16.2日线回测验证）
// 基于70品种全量回测结果，启用表现优秀的品种，软停用弱势品种
// 品种定义保留，通过 DISABLED_VARIETIES 控制是否监控
export const VARIETIES: Record<string, string> = {
  // ===== 上期所 (14个) =====
  CU0: '铜', AL0: '铝', ZN0: '锌', NI0: '镍',
  AG0: '白银', AU0: '黄金',  // 贵金属
  HC0: '热卷', RB0: '螺纹钢', SP0: '纸浆',  // 黑色
  FU0: '燃油', BU0: '沥青', AO0: '氧化铝',
  SS0: '不锈钢', PB0: '铅',  // 20年回测宝藏
  // ===== 上期能源 (4个) =====
  SC0: '原油', LU0: '低硫燃油', BC0: '国际铜', EC0: '集运欧线',
  // ===== 大商所 (13个) =====
  I0: '铁矿石', JM0: '焦煤', J0: '焦炭',  // 黑色系
  P0: '棕榈油', M0: '豆粕', A0: '豆一', Y0: '豆油', C0: '玉米',  // 油脂油料/谷物
  LH0: '生猪', JD0: '鸡蛋',  // 畜牧
  L0: '塑料', V0: 'PVC', PP0: '聚丙烯', EB0: '苯乙烯', PG0: '液化气',
  RU0: '橡胶', NR0: '20号胶',  // 胶类
  // ===== 郑商所 (14个) =====
  AP0: '苹果', CF0: '棉花',  // 农产品
  SA0: '纯碱', FG0: '玻璃',  // 建材
  TA0: 'PTA', EG0: '乙二醇', MA0: '甲醇', RM0: '菜粕', OI0: '菜籽油', SR0: '白糖',  // 能化/农产品
  CJ0: '红枣', SF0: '硅铁', SM0: '锰硅',  // 特色
  WR0: '线材', UR0: '尿素',  // 20年回测宝藏
  PX0: '对二甲苯',
  // ===== 中金所-股指 (4个) =====
  IM0: '中证1000', IF0: '沪深300', IH0: '上证50', IC0: '中证500',
  // ===== 广期所 (2个) =====
  SI0: '工业硅', LC0: '碳酸锂',
  // ===== 国债 (2个) =====
  T0: '10年国债', TF0: '5年国债',
};

// 软停用品种（保留定义但停止监控，未来系统优化后可重新考察）
// 历史软停用记录（这些品种已从 VARIETIES 品种池硬移除，无需再软停用）：
//   TS0 2年国债 -1.1% PF=0.00 / TL0 30年国债 -0.0% PF=0.81 / RR0 粳米 1.6% PF=1.12
//   SH0 烧碱 11.2% PF=1.87 / PF0 短纤 24.4% PF=1.39 / CS0 淀粉 24.1% PF=1.88
export const DISABLED_VARIETIES: Set<string> = new Set([]);

// 检查品种是否启用
export function isEnabledVariety(code: string): boolean {
  return !DISABLED_VARIETIES.has(code);
}

// 金融期货（4个股指 + 2个国债）
export const FINANCIAL_FUTURES = new Set([
  'IM0', 'IF0', 'IH0', 'IC0',  // 股指
  'T0', 'TF0',  // 国债
]);

// 品种分组（用于跨品种联动）
export const VARIETY_GROUPS: Record<string, { members: string[]; leader: string }> = {
  '黑色系': { members: ['HC0', 'RB0', 'I0', 'J0', 'JM0', 'SF0', 'SM0'], leader: 'I0' },
  '有色金属': { members: ['CU0', 'AL0', 'ZN0', 'NI0', 'BC0', 'SS0', 'PB0'], leader: 'CU0' },
  '贵金属': { members: ['AG0', 'AU0'], leader: 'AU0' },
  '能化链': { members: ['SC0', 'BU0', 'TA0', 'MA0', 'EG0', 'PP0', 'L0', 'V0', 'FU0', 'LU0', 'EB0', 'PG0', 'PX0', 'UR0'], leader: 'SC0' },
  '农产品': { members: ['RM0', 'AP0', 'JD0', 'LH0', 'CF0', 'A0', 'M0', 'P0', 'CJ0', 'Y0', 'C0', 'OI0', 'SR0'], leader: 'RM0' },
  '建材': { members: ['FG0', 'SA0'], leader: 'SA0' },
  '股指': { members: ['IM0', 'IF0', 'IH0', 'IC0'], leader: 'IF0' },
  '新材料': { members: ['LC0', 'SI0'], leader: 'LC0' },
  '胶类': { members: ['RU0', 'NR0'], leader: 'RU0' },
  '国债': { members: ['T0', 'TF0'], leader: 'T0' },
  '特殊': { members: ['EC0', 'SP0', 'AO0', 'WR0'], leader: 'EC0' },
};

// 超跌品种白名单
export const OVERSOLD_VARIETIES = new Set([
  'I0', 'JM0', 'CU0', 'SC0', 'AG0', 'LH0', 'SA0',
  'TA0', 'AL0', 'JD0', 'P0', 'EC0', 'LC0', 'MA0',
  'EG0', 'AP0', 'SP0', 'NI0', 'L0', 'PP0', 'BU0',
  // 新启用的宝藏品种
  'AU0', 'RU0', 'RB0', 'CF0', 'IF0', 'IH0', 'IC0',
  'SS0', 'PB0', 'M0', 'A0', 'WR0', 'UR0', 'NR0',
]);

// 品种分组名称映射
export const GROUP_NAMES: Record<string, string> = {
  // 有色金属
  CU0: '有色金属', AL0: '有色金属', ZN0: '有色金属', NI0: '有色金属', BC0: '有色金属', SS0: '有色金属', PB0: '有色金属',
  // 黑色系
  HC0: '黑色系', RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', SF0: '黑色系', SM0: '黑色系',
  // 贵金属
  AU0: '贵金属', AG0: '贵金属',
  // 能化链
  SC0: '能化链', BU0: '能化链', TA0: '能化链', MA0: '能化链', EG0: '能化链',
  PP0: '能化链', L0: '能化链', V0: '能化链', FU0: '能化链', EB0: '能化链', LU0: '能化链',
  PX0: '能化链', UR0: '能化链',
  // 农产品
  A0: '农产品', M0: '农产品', RM0: '农产品', CF0: '农产品',
  AP0: '农产品', CJ0: '农产品', JD0: '农产品', LH0: '农产品', P0: '农产品',
  C0: '农产品', Y0: '农产品', OI0: '农产品', SR0: '农产品',
  // 建材
  FG0: '建材', SA0: '建材',
  // 股指
  IF0: '股指', IH0: '股指', IC0: '股指', IM0: '股指',
  // 新材料
  LC0: '新材料', SI0: '新材料',
  // 胶类
  RU0: '胶类', NR0: '胶类',
  // 国债
  T0: '国债', TF0: '国债',
  // 特殊
  EC0: '特殊', SP0: '特殊', AO0: '特殊', PG0: '特殊', WR0: '特殊',
};

export interface BarData {
  date: string;
  time?: string; // HH:MM format for minute bars
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold?: number;
  settle?: number;
  _index?: number; // Internal field for aggregation
}

export interface ScanResult {
  code: string;
  name: string;
  contract: string;
  close: number;
  change_pct: number;
  spectrum: string;
  ai_direction: string;
  bar_identity: string;
  buy_sell_pressure: string;
  breakout_score: number;
  breakout_label: string;
  trend_strength: number;
  trend_label: string;
  reversal_quality: number;
  overlap_pct: number;
  adx: number;
  plus_di: number;
  minus_di: number;
  atr: number;
  ema20: number;
  ema_dev_pct: number;
  ai_streak: number;
  ai_flip: boolean;
  volume_ratio: number;
  // 高级维度
  trap_type: string;
  climax_detected: boolean;
  wedge_detected: boolean;
  wedge_type: string;  // v12: 楔形类型
  wedge_measurement_target: number;  // v12: 楔形测量目标
  mtr_detected: boolean;
  mtr_type: 'major' | 'minor' | 'none';  // v12: MTR类型（60% minor法则）
  final_flag: boolean;
  final_flag_magnet: boolean;  // v12: Final Flag磁铁效应
  barbwire: boolean;
  outside_bar: string;
  follow_through: number;
  leg_count: number;
  magnet_levels: number[];
  // v12新增维度
  gap_type: 'none' | 'breakaway' | 'measuring' | 'exhaustion';  // 跳空分类
  major_surprise: boolean;  // Major Surprise检测
  bar_40_41_window: boolean;  // Bar 40-41时间窗口
  // 超跌评分
  oversold_score?: number;
  oversold_signal?: string;
  consec_down_days?: number;
  dev_ma20?: number;
  // 信号汇总
  signals: string[];
  signal_level: 'strong' | 'moderate' | 'weak' | 'none';
  // 综合信号强度评分 (0-100)
  signal_strength_score?: number;
}

/**
 * 将合约代码转换为品种代码
 * 例如: "PBL8" -> "PB0", "JDL8" -> "JD0"
 */
export function contractToVarietyCode(contractCode: string): string {
  // 提取品种代码（去掉最后的月份数字）
  const match = contractCode.match(/^([A-Za-z]+)\d+$/);
  if (match) {
    const varietyPrefix = match[1].toUpperCase();
    // 查找匹配的品种代码
    for (const code of Object.keys(VARIETIES)) {
      if (code.startsWith(varietyPrefix) || varietyPrefix.startsWith(code.replace('0', ''))) {
        return code;
      }
    }
    // 如果没有找到，尝试添加 "0" 后缀
    return varietyPrefix + '0';
  }
  return contractCode;
}

/**
 * 动态获取已有回测数据的品种代码列表
 * 扫描 data 目录下所有 *_1000Experiments.json 文件，作为全品种分析的唯一来源
 */
export function listBacktestCodes(): string[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith('_1000Experiments.json'))
    .map((f) => f.replace('_1000Experiments.json', ''))
    .sort();
}
