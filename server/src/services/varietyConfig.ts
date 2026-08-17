/**
 * V16.2 品种配置表
 * 从旧 scoringEngine 提取，独立于评分引擎
 */
export type SupplyElasticity = 'normal' | 'rigid' | 'invalid_cost';

export interface VarietyConfig {
  code: string;
  name: string;
  exchange: string;
  category: string;
  costLine: number | null;       // 成本支撑线（元/吨），null=无成本逻辑
  elasticity: SupplyElasticity;   // 供给弹性
}

export const VARIETY_CONFIGS: Record<string, VarietyConfig> = {
  // 黑色系
  'RB': { code: 'RB', name: '螺纹钢', exchange: 'SHFE', category: '黑色', costLine: 4200, elasticity: 'normal' },
  'I': { code: 'I', name: '铁矿石', exchange: 'DCE', category: '黑色', costLine: 800, elasticity: 'normal' },
  'JM': { code: 'JM', name: '焦煤', exchange: 'DCE', category: '黑色', costLine: 1800, elasticity: 'normal' },
  'J': { code: 'J', name: '焦炭', exchange: 'DCE', category: '黑色', costLine: null, elasticity: 'normal' },
  'HC': { code: 'HC', name: '热卷', exchange: 'SHFE', category: '黑色', costLine: 4200, elasticity: 'normal' },
  'SF': { code: 'SF', name: '硅铁', exchange: 'CZCE', category: '黑色', costLine: null, elasticity: 'normal' },
  'SM': { code: 'SM', name: '锰硅', exchange: 'CZCE', category: '黑色', costLine: null, elasticity: 'normal' },

  // 农产品
  'M': { code: 'M', name: '豆粕', exchange: 'DCE', category: '农产品', costLine: 3700, elasticity: 'normal' },
  'JD': { code: 'JD', name: '鸡蛋', exchange: 'DCE', category: '农产品', costLine: 3540, elasticity: 'normal' },
  'LH': { code: 'LH', name: '生猪', exchange: 'DCE', category: '农产品', costLine: 14000, elasticity: 'normal' },
  'CF': { code: 'CF', name: '棉花', exchange: 'CZCE', category: '农产品', costLine: 16000, elasticity: 'normal' },
  'P': { code: 'P', name: '棕榈油', exchange: 'DCE', category: '农产品', costLine: 8000, elasticity: 'normal' },

  // 能化
  'RU': { code: 'RU', name: '橡胶', exchange: 'SHFE', category: '能化', costLine: 14000, elasticity: 'rigid' },
  'SA': { code: 'SA', name: '纯碱', exchange: 'CZCE', category: '能化', costLine: 1600, elasticity: 'normal' },
  'TA': { code: 'TA', name: 'PTA', exchange: 'CZCE', category: '能化', costLine: 5800, elasticity: 'normal' },
  'SC': { code: 'SC', name: '原油', exchange: 'INE', category: '能化', costLine: 500, elasticity: 'normal' },

  // 有色
  'CU': { code: 'CU', name: '沪铜', exchange: 'SHFE', category: '有色', costLine: 68000, elasticity: 'rigid' },
  'AL': { code: 'AL', name: '沪铝', exchange: 'SHFE', category: '有色', costLine: 17500, elasticity: 'rigid' },

  // 贵金属
  'AU': { code: 'AU', name: '沪金', exchange: 'SHFE', category: '贵金属', costLine: null, elasticity: 'invalid_cost' },
  'AG': { code: 'AG', name: '沪银', exchange: 'SHFE', category: '贵金属', costLine: null, elasticity: 'invalid_cost' },

  // 新材料
  'SI': { code: 'SI', name: '工业硅', exchange: 'GFEX', category: '新材料', costLine: 9500, elasticity: 'normal' },
  'LC': { code: 'LC', name: '碳酸锂', exchange: 'GFEX', category: '新材料', costLine: 80000, elasticity: 'normal' },
  'PS': { code: 'PS', name: '多晶硅', exchange: 'GFEX', category: '新材料', costLine: 42000, elasticity: 'normal' },

  // 其他
  'SP': { code: 'SP', name: '纸浆', exchange: 'SHFE', category: '林纸', costLine: 5500, elasticity: 'normal' },
  'EC': { code: 'EC', name: '集运指数', exchange: 'INE', category: '航运', costLine: null, elasticity: 'invalid_cost' },
};
