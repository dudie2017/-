/**
 * 传播链白名单：基于产业链/板块领域知识的"真联动"传播对
 * 来源：v7 滚动前向验证结论——机器学习传播对不可靠（同期巧合），
 *       但板块内/产业链联动跨20年稳定（黑色/有色/贵金属/油脂/软商品/股指）。
 * 用途：M3 方向确认辅助（leader 冲击后 follower 同向跟随确认方向）
 * 注意：跨板块对仅限"真实产业链上下游"（如 SS0→NI0 不锈钢→镍），禁止同期巧合对。
 *
 * hr 字段：基于 20 年日线回测的 follower 跟随命中率（阈值 2×ATR + next1 确认口径，
 * 样本不足 N<10 时退化为 1×ATR 有确认口径）。用于置信度评分，非硬过滤。
 */
export interface WhitelistPair {
  leader: string;
  follower: string;
  lag: number;       // 预期滞后天数（1-5）
  sector: string;    // 板块归属（用于板块命中率统计）
  hr: number;        // 历史跟随命中率（0-1，回测验证）
  logic: string;     // 联动逻辑说明
}

export const PROPAGATION_WHITELIST: WhitelistPair[] = [
  // ========== 黑色系（钢材产业链） ==========
  { leader: 'I0', follower: 'RB0', lag: 1, sector: '黑色系', hr: 0.75, logic: '铁矿→螺纹（上游原材料→钢材）' },
  { leader: 'I0', follower: 'HC0', lag: 1, sector: '黑色系', hr: 0.73, logic: '铁矿→热卷（上游原材料→板材）' },
  { leader: 'J0', follower: 'RB0', lag: 1, sector: '黑色系', hr: 0.85, logic: '焦炭→螺纹（炉料→钢材）' },
  { leader: 'JM0', follower: 'J0', lag: 1, sector: '黑色系', hr: 0.72, logic: '焦煤→焦炭（上游→炉料）' },
  { leader: 'RB0', follower: 'HC0', lag: 1, sector: '黑色系', hr: 0.67, logic: '螺纹→热卷（钢材同向）' },
  { leader: 'RB0', follower: 'I0', lag: 1, sector: '黑色系', hr: 0.64, logic: '螺纹→铁矿（成材利润传导）' },
  { leader: 'HC0', follower: 'SS0', lag: 1, sector: '黑色系', hr: 0.55, logic: '热卷→不锈钢（板材外溢）' },

  // ========== 有色（同板块联动） ==========
  { leader: 'CU0', follower: 'AL0', lag: 1, sector: '有色', hr: 0.60, logic: '铜→铝（工业金属同向）' },
  { leader: 'CU0', follower: 'ZN0', lag: 1, sector: '有色', hr: 0.66, logic: '铜→锌（工业金属同向）' },
  { leader: 'AL0', follower: 'ZN0', lag: 1, sector: '有色', hr: 0.88, logic: '铝→锌（工业金属同向）' },
  { leader: 'CU0', follower: 'BC0', lag: 1, sector: '有色', hr: 0.95, logic: '铜→国际铜（同品种内外盘）' },
  { leader: 'NI0', follower: 'SS0', lag: 1, sector: '有色', hr: 0.55, logic: '镍→不锈钢（产业链：镍是不锈钢原料）' },

  // ========== 贵金属 ==========
  { leader: 'AU0', follower: 'AG0', lag: 1, sector: '贵金属', hr: 0.73, logic: '黄金→白银（贵金属同向，白银弹性更大）' },
  { leader: 'AG0', follower: 'AU0', lag: 1, sector: '贵金属', hr: 0.74, logic: '白银→黄金（贵金属联动）' },

  // ========== 油脂油料（产业链/替代） ==========
  { leader: 'M0', follower: 'RM0', lag: 1, sector: '油脂油料', hr: 0.74, logic: '豆粕→菜粕（蛋白粕替代）' },
  { leader: 'Y0', follower: 'OI0', lag: 1, sector: '油脂油料', hr: 0.67, logic: '豆油→菜油（油脂替代）' },
  { leader: 'Y0', follower: 'P0', lag: 1, sector: '油脂油料', hr: 0.83, logic: '豆油→棕榈油（油脂替代）' },
  { leader: 'A0', follower: 'M0', lag: 1, sector: '油脂油料', hr: 0.75, logic: '豆一→豆粕（大豆→压榨）' },
  { leader: 'RM0', follower: 'OI0', lag: 1, sector: '油脂油料', hr: 0.60, logic: '菜粕→菜油（菜籽压榨产业链）' },

  // ========== 软商品 ==========
  { leader: 'CF0', follower: 'SR0', lag: 1, sector: '软商品', hr: 0.62, logic: '棉花→白糖（软商品同向）' },
  { leader: 'C0', follower: 'AP0', lag: 1, sector: '软商品', hr: 0.56, logic: '玉米→苹果（农产品联动）' },

  // ========== 能源（原油产业链） ==========
  { leader: 'SC0', follower: 'FU0', lag: 1, sector: '能源', hr: 0.79, logic: '原油→燃料油（炼化下游）' },
  { leader: 'SC0', follower: 'LU0', lag: 1, sector: '能源', hr: 0.79, logic: '原油→低硫燃料油（炼化下游）' },
  { leader: 'SC0', follower: 'BU0', lag: 1, sector: '能源', hr: 0.68, logic: '原油→沥青（炼化下游）' },
  { leader: 'SC0', follower: 'PG0', lag: 1, sector: '能源', hr: 0.79, logic: '原油→LPG（油气联动）' },

  // ========== 化工（产业链） ==========
  { leader: 'TA0', follower: 'PX0', lag: 1, sector: '化工', hr: 0.92, logic: 'PTA→对二甲苯（PX是PTA原料）' },
  { leader: 'L0', follower: 'PP0', lag: 1, sector: '化工', hr: 0.92, logic: '塑料→聚丙烯（烯烃替代）' },
  { leader: 'RU0', follower: 'NR0', lag: 1, sector: '化工', hr: 0.92, logic: '橡胶→20号胶（同品种）' },
  { leader: 'MA0', follower: 'EG0', lag: 1, sector: '化工', hr: 0.77, logic: '甲醇→乙二醇（化工联动）' },

  // ========== 金融（股指/国债） ==========
  { leader: 'IF0', follower: 'IH0', lag: 1, sector: '金融', hr: 0.67, logic: '沪深300→上证50（大盘股同向）' },
  { leader: 'IF0', follower: 'IC0', lag: 1, sector: '金融', hr: 0.87, logic: '沪深300→中证500（股指同向）' },
  { leader: 'IH0', follower: 'IF0', lag: 1, sector: '金融', hr: 0.92, logic: '上证50→沪深300（大盘联动）' },
  { leader: 'IC0', follower: 'IM0', lag: 1, sector: '金融', hr: 0.91, logic: '中证500→中证1000（中小盘同向）' },
  { leader: 'T0', follower: 'TF0', lag: 1, sector: '金融', hr: 0.88, logic: '十债→五债（利率同向）' },

  // ========== 跨板块真产业链（唯一允许的跨板块） ==========
  { leader: 'SS0', follower: 'NI0', lag: 1, sector: '黑色系', hr: 0.68, logic: '不锈钢→镍（镍是不锈钢核心原料）' },
  { leader: 'ZC0', follower: 'JM0', lag: 1, sector: '黑色系', hr: 0.60, logic: '动力煤→焦煤（煤炭联动）' },

  // ========== E1扩容：线材（WR0，修正：原误标为"动力煤"，WR0 实为线材） ==========
  { leader: 'WR0', follower: 'I0', lag: 1, sector: '黑色系', hr: 0.70, logic: '线材→铁矿（钢材→原料）' },
  { leader: 'WR0', follower: 'J0', lag: 2, sector: '黑色系', hr: 0.55, logic: '线材→焦炭（钢材→炉料）' },

  // ========== E1扩容：能源（FU0，能源板块联动） ==========
  { leader: 'FU0', follower: 'LU0', lag: 2, sector: '能源', hr: 0.62, logic: '燃料油→低硫燃油（同板块）' },
  { leader: 'FU0', follower: 'SC0', lag: 1, sector: '能源', hr: 0.71, logic: '燃料油→原油（能源联动）' },
  { leader: 'FU0', follower: 'PG0', lag: 2, sector: '能源', hr: 0.69, logic: '燃料油→LPG（油气联动）' },

  // ========== E1扩容：能源→化工/黑色（跨板块产业链） ==========
  { leader: 'FU0', follower: 'HC0', lag: 1, sector: '能源', hr: 0.67, logic: '燃料油→热卷（能源成本→钢材）' },

  // ========== E1扩容：软商品（CF0，板块联动扩展） ==========
  { leader: 'CF0', follower: 'AP0', lag: 1, sector: '软商品', hr: 0.57, logic: '棉花→苹果（农产品同向）' },

  // ========== E1扩容：油脂油料（M0/A0 板块联动扩展） ==========
  { leader: 'A0', follower: 'Y0', lag: 1, sector: '油脂油料', hr: 0.71, logic: '豆一→豆油（大豆→压榨）' },

  // ========== E2扩容：未覆盖品种（SF0/SM0/SR0/P0/SA0/PG0） ==========
  { leader: 'SF0', follower: 'SM0', lag: 1, sector: '黑色系', hr: 0.63, logic: '硅铁→锰硅（铁合金联动）' },
  { leader: 'RB0', follower: 'SF0', lag: 2, sector: '黑色系', hr: 0.70, logic: '螺纹钢→硅铁（钢材→炼钢铁合金）' },
  { leader: 'SM0', follower: 'SF0', lag: 1, sector: '黑色系', hr: 0.63, logic: '锰硅→硅铁（铁合金联动）' },
  { leader: 'SM0', follower: 'I0', lag: 2, sector: '黑色系', hr: 0.72, logic: '锰硅→铁矿（黑色系联动）' },
  { leader: 'SR0', follower: 'CF0', lag: 1, sector: '软商品', hr: 0.68, logic: '白糖→棉花（软商品联动）' },
  { leader: 'P0', follower: 'Y0', lag: 1, sector: '油脂油料', hr: 0.94, logic: '棕榈油→豆油（油脂替代效应）' },
  { leader: 'P0', follower: 'M0', lag: 2, sector: '油脂油料', hr: 0.63, logic: '棕榈油→豆粕（油料联动）' },
  { leader: 'SA0', follower: 'WR0', lag: 3, sector: '黑色系', hr: 0.58, logic: '纯碱→线材（化工→钢材）' },
  { leader: 'PG0', follower: 'FU0', lag: 2, sector: '能源', hr: 0.62, logic: 'LPG→燃油（能源联动）' },
  { leader: 'PG0', follower: 'LU0', lag: 2, sector: '能源', hr: 0.62, logic: 'LPG→低硫燃油（能源联动）' },
];
