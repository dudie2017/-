/**
 * 交易成本精细化配置（方向五 P0）
 * 
 * 按品种查表，支持：
 * - 交易所手续费（按品种不同费率）
 * - 期货公司佣金加成
 * - 平今仓加收（部分品种平今手续费翻倍）
 */

// ===== 手续费率配置 =====

export interface FeeConfig {
  code: string;
  name: string;
  // 开仓费率（成交金额的比例）- 与 fixedFeePerLot 二选一
  openFeeRate?: number;
  // 平仓费率（成交金额的比例）- 与 fixedFeePerLot 二选一
  closeFeeRate?: number;
  // 平今仓费率（如果平今加收，这里设置更高）
  closeTodayFeeRate?: number;
  // 按固定金额收费（如股指期货按手数收费）- 与 openFeeRate/closeFeeRate 二选一
  fixedFeePerLot?: number;
  // 备注
  note?: string;
}

// 主要品种手续费配置（2024 年标准）
// 数据来源：各交易所官网，期货公司一般加收 0.5-1 倍
export const FEE_TABLE: Record<string, FeeConfig> = {
  // ===== 黑色系 =====
  RB0: { code: 'RB0', name: '螺纹钢', openFeeRate: 0.0001, closeFeeRate: 0.0001, closeTodayFeeRate: 0.0001, note: '平今不加收' },
  HC0: { code: 'HC0', name: '热卷', openFeeRate: 0.0001, closeFeeRate: 0.0001, closeTodayFeeRate: 0.0001, note: '平今不加收' },
  I0: { code: 'I0', name: '铁矿石', openFeeRate: 0.0001, closeFeeRate: 0.0001, note: '万分之' },
  J0: { code: 'J0', name: '焦炭', openFeeRate: 0.00007, closeFeeRate: 0.00007, closeTodayFeeRate: 0.00014, note: '平今翻倍' },
  JM0: { code: 'JM0', name: '焦煤', openFeeRate: 0.00007, closeFeeRate: 0.00007, closeTodayFeeRate: 0.00014, note: '平今翻倍' },

  // ===== 有色 =====
  CU0: { code: 'CU0', name: '铜', openFeeRate: 0.00005, closeFeeRate: 0.00005, note: '万分之零点五' },
  AL0: { code: 'AL0', name: '铝', openFeeRate: 0.00003, closeFeeRate: 0.00003, note: '万分之零点三' },
  ZN0: { code: 'ZN0', name: '锌', openFeeRate: 0.00003, closeFeeRate: 0.00003 },
  PB0: { code: 'PB0', name: '铅', openFeeRate: 0.00004, closeFeeRate: 0.00004 },
  NI0: { code: 'NI0', name: '镍', openFeeRate: 0.00003, closeFeeRate: 0.00003, closeTodayFeeRate: 0.00006, note: '平今翻倍' },
  SN0: { code: 'SN0', name: '锡', openFeeRate: 0.00003, closeFeeRate: 0.00003 },

  // ===== 农产品 =====
  CF0: { code: 'CF0', name: '棉花', openFeeRate: 0.000043, closeFeeRate: 0.000043, note: '4.3元/手' },
  SR0: { code: 'SR0', name: '白糖', openFeeRate: 0.00003, closeFeeRate: 0.00003, note: '3元/手' },
  TA0: { code: 'TA0', name: 'PTA', openFeeRate: 0.00003, closeFeeRate: 0.00003, closeTodayFeeRate: 0, note: '平今免费' },
  OI0: { code: 'OI0', name: '菜油', openFeeRate: 0.00002, closeFeeRate: 0.00002 },
  RM0: { code: 'RM0', name: '菜粕', openFeeRate: 0.000015, closeFeeRate: 0.000015, closeTodayFeeRate: 0, note: '平今免费' },
  Y0: { code: 'Y0', name: '豆油', openFeeRate: 0.000025, closeFeeRate: 0.000025 },
  M0: { code: 'M0', name: '豆粕', openFeeRate: 0.000015, closeFeeRate: 0.000015, closeTodayFeeRate: 0, note: '平今免费' },
  P0: { code: 'P0', name: '棕榈油', openFeeRate: 0.000025, closeFeeRate: 0.000025 },
  AP0: { code: 'AP0', name: '苹果', openFeeRate: 0.00005, closeFeeRate: 0.00005, closeTodayFeeRate: 0.0001, note: '平今翻倍' },
  CJ0: { code: 'CJ0', name: '红枣', openFeeRate: 0.00003, closeFeeRate: 0.00003 },

  // ===== 能源化工 =====
  SC0: { code: 'SC0', name: '原油', openFeeRate: 0.00002, closeFeeRate: 0.00002, closeTodayFeeRate: 0, note: '平今免费' },
  FU0: { code: 'FU0', name: '燃油', openFeeRate: 0.00001, closeFeeRate: 0.00001, closeTodayFeeRate: 0.00003, note: '平今三倍' },
  LU0: { code: 'LU0', name: '低硫燃油', openFeeRate: 0.00001, closeFeeRate: 0.00001 },
  BU0: { code: 'BU0', name: '沥青', openFeeRate: 0.00001, closeFeeRate: 0.00001, closeTodayFeeRate: 0.00003, note: '平今三倍' },
  MA0: { code: 'MA0', name: '甲醇', openFeeRate: 0.00002, closeFeeRate: 0.00002, closeTodayFeeRate: 0.00006, note: '平今三倍' },
  PP0: { code: 'PP0', name: '聚丙烯', openFeeRate: 0.00006, closeFeeRate: 0.00006 },
  PE0: { code: 'PE0', name: '聚乙烯', openFeeRate: 0.00006, closeFeeRate: 0.00006 },
  EG0: { code: 'EG0', name: '乙二醇', openFeeRate: 0.00004, closeFeeRate: 0.00004, closeTodayFeeRate: 0.00006, note: '平今加收' },
  EB0: { code: 'EB0', name: '苯乙烯', openFeeRate: 0.00003, closeFeeRate: 0.00003, closeTodayFeeRate: 0.00007, note: '平今翻倍' },

  // ===== 股指 =====
  IF0: { code: 'IF0', name: '沪深300股指', fixedFeePerLot: 23, note: '万分之0.23，按手数' },
  IH0: { code: 'IH0', name: '上证50股指', fixedFeePerLot: 18, note: '万分之0.23，按手数' },
  IC0: { code: 'IC0', name: '中证500股指', fixedFeePerLot: 20, note: '万分之0.23，按手数' },
  IM0: { code: 'IM0', name: '中证1000股指', fixedFeePerLot: 23, note: '万分之0.23，按手数' },

  // ===== 贵金属 =====
  AU0: { code: 'AU0', name: '黄金', openFeeRate: 0.00001, closeFeeRate: 0.00001, closeTodayFeeRate: 0, note: '平今免费' },
  AG0: { code: 'AG0', name: '白银', openFeeRate: 0.000005, closeFeeRate: 0.000005, closeTodayFeeRate: 0.000015, note: '平今三倍' },

  // ===== 其他 =====
  SP0: { code: 'SP0', name: '纸浆', openFeeRate: 0.00005, closeFeeRate: 0.00005 },
  LH0: { code: 'LH0', name: '生猪', openFeeRate: 0.0001, closeFeeRate: 0.0001, closeTodayFeeRate: 0.0002, note: '平今翻倍' },
};

// 默认费率（未配置的品种使用此费率）
export const DEFAULT_FEE_CONFIG: FeeConfig = {
  code: 'DEFAULT',
  name: '默认',
  openFeeRate: 0.00015,  // 万分之1.5
  closeFeeRate: 0.00015,
  note: '默认费率',
};

// ===== 费率计算函数 =====

/**
 * 获取品种手续费配置
 */
export function getFeeConfig(code: string): FeeConfig {
  return FEE_TABLE[code] || DEFAULT_FEE_CONFIG;
}

/**
 * 计算开仓手续费
 * @param code 品种代码
 * @param price 成交价格
 * @param quantity 手数
 * @param multiplier 合约乘数
 */
export function calcOpenFee(code: string, price: number, quantity: number, multiplier: number): number {
  const config = getFeeConfig(code);
  
  // 按固定金额收费（如股指期货）
  if (config.fixedFeePerLot) {
    return config.fixedFeePerLot * quantity;
  }
  
  // 按成交金额比例收费
  const contractValue = price * quantity * multiplier;
  return contractValue * (config.openFeeRate ?? DEFAULT_FEE_CONFIG.openFeeRate!);
}

/**
 * 计算平仓手续费
 * @param code 品种代码
 * @param price 成交价格
 * @param quantity 手数
 * @param multiplier 合约乘数
 * @param isToday 是否平今仓
 */
export function calcCloseFee(code: string, price: number, quantity: number, multiplier: number, isToday: boolean = false): number {
  const config = getFeeConfig(code);
  
  // 按固定金额收费（如股指期货）
  if (config.fixedFeePerLot) {
    return config.fixedFeePerLot * quantity;
  }
  
  // 按成交金额比例收费
  const contractValue = price * quantity * multiplier;
  const feeRate = isToday && config.closeTodayFeeRate !== undefined
    ? config.closeTodayFeeRate
    : (config.closeFeeRate ?? DEFAULT_FEE_CONFIG.closeFeeRate!);
  
  return contractValue * feeRate;
}

/**
 * 计算往返手续费（开仓 + 平仓）
 */
export function calcRoundTripFee(
  code: string,
  openPrice: number,
  closePrice: number,
  quantity: number,
  multiplier: number,
  isToday: boolean = false
): number {
  const openFee = calcOpenFee(code, openPrice, quantity, multiplier);
  const closeFee = calcCloseFee(code, closePrice, quantity, multiplier, isToday);
  return openFee + closeFee;
}

/**
 * 获取品种合约乘数
 */
export function getMultiplier(code: string): number {
  const MULTIPLIER_TABLE: Record<string, number> = {
    // 黑色系
    RB0: 10, HC0: 10, I0: 100, J0: 100, JM0: 60,
    // 有色
    CU0: 5, AL0: 5, ZN0: 5, PB0: 5, NI0: 1, SN0: 1,
    // 农产品
    CF0: 5, SR0: 10, TA0: 5, OI0: 10, RM0: 10,
    Y0: 10, M0: 10, P0: 10, AP0: 10, CJ0: 5,
    // 能源化工
    SC0: 1000, FU0: 10, LU0: 10, BU0: 10,
    MA0: 10, PP0: 5, PE0: 5, EG0: 10, EB0: 5,
    // 股指
    IF0: 300, IH0: 300, IC0: 200, IM0: 200,
    // 贵金属
    AU0: 1000, AG0: 15,
    // 其他
    SP0: 10, LH0: 16,
  };
  return MULTIPLIER_TABLE[code] || 10;
}
