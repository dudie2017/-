import AsyncStorage from '@react-native-async-storage/async-storage';

// ============ 训练数据模型 ============

export interface TrainingStats {
  totalReturn: number;
  winRate: number;
  levelsCleared: number;
  totalTrades: number;
  totalCorrect: number;
  xp: number;
  level: number;
  consecutiveCorrect: number;
  maxConsecutiveCorrect: number;
  signalAligned: number; // 与Always In方向一致的交易次数
  signalTotal: number;   // 总交易次数（用于信号对齐率）
}

export interface LevelProgress {
  levelId: string;
  varietyCode: string;
  category: string;
  difficulty: number;
  status: 'locked' | 'available' | 'cleared';
  stars: number;
  bestScore: number;
  bestReturn: number;
  attempts: number;
  lastPlayTime?: string;
}

export interface SpecialTrainingProgress {
  moduleId: string;
  currentQuestion: number;
  correctCount: number;
  totalCount: number;
  bestScore: number;
  lastPlayTime?: string;
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  icon: string;
  unlocked: boolean;
  unlockedAt?: string;
}

export interface TrainingData {
  stats: TrainingStats;
  levels: Record<string, LevelProgress>;
  specialTraining: Record<string, SpecialTrainingProgress>;
  achievements: Achievement[];
}

// K线数据
export interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
}

// 答题记录
export interface QuizQuestionData {
  id: string;
  moduleId: string;
  type: 'multi' | 'tap';
  question: string;
  options?: { label: string; value: string }[];
  correctAnswer?: string;
  correctBarIndex?: number;
  explanation: string;
  chartBars: Bar[];
  highlightBars?: number[];
  targetBar?: number;
}

// 错题记录
export interface ErrorQuestion {
  id: string;
  moduleId: string;
  moduleName: string;
  question: string;
  options: { label: string; value: string }[];
  correctAnswer: string;
  userAnswer: string;
  explanation: string;
  timestamp: string;
}

// 评分细分
export interface ScoreBreakdown {
  directionScore: number;   // 方向判断 0-25
  timingScore: number;      // 入场时机 0-25
  stopLossScore: number;    // 止损设置 0-25
  managementScore: number;  // 持仓管理 0-25
  total: number;            // 总分 0-100
}

// ============ 默认数据 ============

const DEFAULT_STATS: TrainingStats = {
  totalReturn: 0,
  winRate: 0,
  levelsCleared: 0,
  totalTrades: 0,
  totalCorrect: 0,
  xp: 0,
  level: 1,
  consecutiveCorrect: 0,
  maxConsecutiveCorrect: 0,
  signalAligned: 0,
  signalTotal: 0,
};

const STORAGE_KEY = '@brooks_training_data';
const ERROR_KEY = '@brooks_error_questions';

// ============ 品类定义（对齐后端 59 品种回测池，剔除无回测数据品种） ============

export const CATEGORY_VARIETIES: Record<string, { code: string; name: string }[]> = {
  '黑色系': [
    { code: 'RB0', name: '螺纹钢' }, { code: 'HC0', name: '热卷' },
    { code: 'I0', name: '铁矿石' }, { code: 'J0', name: '焦炭' }, { code: 'JM0', name: '焦煤' },
  ],
  '有色金属': [
    { code: 'CU0', name: '铜' }, { code: 'AL0', name: '铝' },
    { code: 'ZN0', name: '锌' }, { code: 'NI0', name: '镍' },
    { code: 'PB0', name: '铅' }, { code: 'BC0', name: '国际铜' },
  ],
  '贵金属': [
    { code: 'AU0', name: '黄金' }, { code: 'AG0', name: '白银' },
  ],
  '能化链': [
    { code: 'SC0', name: '原油' }, { code: 'LU0', name: '低硫燃油' },
    { code: 'BU0', name: '沥青' }, { code: 'TA0', name: 'PTA' },
    { code: 'MA0', name: '甲醇' }, { code: 'EG0', name: '乙二醇' },
    { code: 'PP0', name: '聚丙烯' }, { code: 'L0', name: '塑料' },
    { code: 'V0', name: 'PVC' }, { code: 'FU0', name: '燃油' },
    { code: 'NR0', name: '20号胶' }, { code: 'RU0', name: '橡胶' },
    { code: 'EB0', name: '苯乙烯' },
    { code: 'PX0', name: '对二甲苯' },
    { code: 'PG0', name: '液化气' }, { code: 'UR0', name: '尿素' },
  ],
  '农产品': [
    { code: 'A0', name: '豆一' }, { code: 'M0', name: '豆粕' },
    { code: 'Y0', name: '豆油' }, { code: 'OI0', name: '菜油' },
    { code: 'RM0', name: '菜粕' }, { code: 'C0', name: '玉米' },
    { code: 'CF0', name: '棉花' },
    { code: 'SR0', name: '白糖' }, { code: 'AP0', name: '苹果' },
    { code: 'JD0', name: '鸡蛋' }, { code: 'LH0', name: '生猪' },
    { code: 'CJ0', name: '红枣' },
    { code: 'P0', name: '棕榈油' },
  ],
  '建材': [
    { code: 'FG0', name: '玻璃' }, { code: 'SA0', name: '纯碱' },
  ],
  '股指': [
    { code: 'IF0', name: '沪深300' }, { code: 'IH0', name: '上证50' },
    { code: 'IC0', name: '中证500' }, { code: 'IM0', name: '中证1000' },
  ],
  '国债': [
    { code: 'T0', name: '10年国债' }, { code: 'TF0', name: '5年国债' },
  ],
  '新材料': [
    { code: 'LC0', name: '碳酸锂' }, { code: 'SI0', name: '工业硅' },
  ],
  '特殊': [
    { code: 'EC0', name: '集运欧线' }, { code: 'SP0', name: '纸浆' },
    { code: 'AO0', name: '氧化铝' }, { code: 'SS0', name: '不锈钢' },
    { code: 'SF0', name: '硅铁' }, { code: 'SM0', name: '锰硅' },
    { code: 'WR0', name: '线材' },
  ],
};

// 难度定义
export const DIFFICULTY_LEVELS = [
  { id: 1, name: '入门', color: '#00FF88', desc: '基础K线识别' },
  { id: 2, name: '进阶', color: '#00F0FF', desc: '趋势与通道' },
  { id: 3, name: '高级', color: '#BF00FF', desc: '复杂形态' },
  { id: 4, name: '大师', color: '#FFD700', desc: '综合实战' },
];

// ============ 关卡生成（59品种 × 4难度 × 4窗口 = 944关） ============

export interface TrainingLevel {
  id: string;
  category: string;
  variety: { code: string; name: string };
  difficulty: number;
  windowStart: number; // K线数据窗口起始偏移 (0/20/40/60)
  name: string;
}

// 4个时间窗口：每品种120根K线，取不同区间
const WINDOW_OFFSETS = [0, 20, 40, 60];

export function generateLevels(): TrainingLevel[] {
  const levels: TrainingLevel[] = [];
  for (const [category, varieties] of Object.entries(CATEGORY_VARIETIES)) {
    for (const variety of varieties) {
      for (const diff of DIFFICULTY_LEVELS) {
        for (let w = 0; w < WINDOW_OFFSETS.length; w++) {
          levels.push({
            id: `${category}-${diff.id}-${variety.code}-w${w + 1}`,
            category,
            variety,
            difficulty: diff.id,
            windowStart: WINDOW_OFFSETS[w],
            name: `${variety.name}·${diff.name}·窗口${w + 1}`,
          });
        }
      }
    }
  }
  return levels;
}

// ============ 专项训练模块定义 ============

export const SPECIAL_TRAINING_MODULES = [
  { id: 'signal_bar', name: '信号K线识别', icon: 'crosshairs', color: '#00F0FF', desc: '识别关键信号K线：信号棒、入场棒、跟进棒', questionCount: 99 },
  { id: 'volume_oi', name: '量仓分析', icon: 'chart-bar', color: '#BF00FF', desc: '通过成交量和持仓量变化判断趋势强度', questionCount: 99 },
  { id: 'breakout', name: '突破验证', icon: 'bolt', color: '#FFB800', desc: '判断突破是否有效：信号棒+收盘确认', questionCount: 99 },
  { id: 'market_state', name: '市场三态', icon: 'arrows-rotate', color: '#00FF88', desc: '识别趋势/通道/震荡三种市场状态', questionCount: 99 },
  { id: 'always_in', name: 'Always In方向', icon: 'compass', color: '#FF003C', desc: '判断当前Always In多头还是空头', questionCount: 99 },
  { id: 'stop_loss', name: '止损位设置', icon: 'shield-halved', color: '#FF4444', desc: '选择最优止损位：信号棒极值/均线/摆动点', questionCount: 99 },
  { id: 'basic_patterns', name: 'K线基础', icon: 'chart-line', color: '#00F0FF', desc: '十字星/锤子线/吞没形态等基础K线识别', questionCount: 99 },
  { id: 'pullback', name: '回踩入场', icon: 'rotate-left', color: '#BF00FF', desc: '识别回踩EMA20的入场时机', questionCount: 99 },
  { id: 'risk_management', name: '仓位与风控', icon: 'scale-balanced', color: '#FFD700', desc: '交易者方程/加仓时机/时间止损', questionCount: 99 },
  { id: 'error_review', name: '错题回顾', icon: 'clipboard-list', color: '#FFB800', desc: '回顾之前答错的题目，强化薄弱环节', questionCount: 99 },
  { id: 'socratic', name: '每日苏格拉底', icon: 'brain', color: '#00FF88', desc: '每日5题，通过提问引导深度思考', questionCount: 5 },
  { id: 'radar_v16', name: '雷达V16.2', icon: 'satellite-dish', color: '#00F0FF', desc: '学习使用V16.2信号驱动决策系统', questionCount: 99 },
  { id: 'variety_traits', name: '品种性格', icon: 'masks-theater', color: '#BF00FF', desc: '了解各品种独特的波动规律和交易特性', questionCount: 99 },
];

// ============ 成就定义 ============

export const DEFAULT_ACHIEVEMENTS: Achievement[] = [
  { id: 'first_win', name: '初战告捷', desc: '完成第一关', icon: 'trophy', unlocked: false },
  { id: 'ten_wins', name: '十连胜', desc: '连续答对10题', icon: 'fire', unlocked: false },
  { id: 'fifty_wins', name: '五十连胜', desc: '连续答对50题', icon: 'gem', unlocked: false },
  { id: 'all_categories', name: '全能战士', desc: '每个品类至少通关1关', icon: 'gavel', unlocked: false },
  { id: 'perfect_score', name: '满分通关', desc: '任意关卡获得3星', icon: 'star', unlocked: false },
  { id: 'speed_demon', name: '闪电手', desc: '30秒内完成一关', icon: 'bolt', unlocked: false },
  { id: 'black_belt', name: '黑带', desc: '通关所有大师难度', icon: 'award', unlocked: false },
  { id: 'scholar', name: '学者', desc: '完成所有专项训练模块', icon: 'graduation-cap', unlocked: false },
  { id: 'streak_7', name: '七日精进', desc: '连续7天训练', icon: 'calendar-check', unlocked: false },
  { id: 'profitable', name: '盈利者', desc: '累计收益率超过10%', icon: 'sack-dollar', unlocked: false },
  { id: 'risk_master', name: '风控大师', desc: '连续20笔交易止损正确', icon: 'shield-halved', unlocked: false },
  { id: 'trend_reader', name: '趋势阅读者', desc: '正确识别50次趋势方向', icon: 'book-open', unlocked: false },
  { id: 'volume_expert', name: '量仓专家', desc: '量仓分析模块得分超过80%', icon: 'chart-bar', unlocked: false },
  { id: 'pattern_master', name: '形态大师', desc: 'K线基础模块全部通关', icon: 'palette', unlocked: false },
  { id: 'level_10', name: '十级段位', desc: '段位达到10级', icon: 'medal', unlocked: false },
  { id: 'level_20', name: '二十级段位', desc: '段位达到20级', icon: 'ranking-star', unlocked: false },
  { id: 'century', name: '百关斩将', desc: '通关100个关卡', icon: 'flag-checkered', unlocked: false },
];

// ============ 段位系统 ============

export function getRankInfo(xp: number): { rank: number; title: string; currentXP: number; nextXP: number; progress: number } {
  const titles = [
    '新手学徒', '初级交易员', '见习分析师', '初级分析师',
    '中级分析师', '高级分析师', '资深分析师', '首席分析师',
    '交易专家', '高级交易专家', '策略大师', '高级策略大师',
    '市场先知', '趋势猎手', '价格行为大师', 'Brooks门徒',
    '传奇交易员', '市场之王', '不朽传奇', '价格行为之神',
  ];
  const rank = Math.min(Math.floor(xp / 100) + 1, 20);
  const currentXP = xp % 100;
  const nextXP = 100;
  const progress = currentXP / nextXP;
  const title = titles[rank - 1] || titles[titles.length - 1];
  return { rank, title, currentXP, nextXP, progress };
}

// ============ 存储操作 ============

export async function loadTrainingData(): Promise<TrainingData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as TrainingData;
      if (!data.achievements || data.achievements.length === 0) {
        data.achievements = [...DEFAULT_ACHIEVEMENTS];
      }
      return data;
    }
  } catch (e) {
    console.error('[Training] load data error:', e);
  }
  return {
    stats: { ...DEFAULT_STATS },
    levels: {},
    specialTraining: {},
    achievements: [...DEFAULT_ACHIEVEMENTS],
  };
}

export async function saveTrainingData(data: TrainingData): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('[Training] save data error:', e);
  }
}

// 更新关卡进度
export function updateLevelProgress(
  data: TrainingData,
  levelId: string,
  varietyCode: string,
  category: string,
  difficulty: number,
  score: number,
  stars: number,
  ret: number,
): TrainingData {
  const existing = data.levels[levelId];
  const updated: LevelProgress = {
    levelId,
    varietyCode,
    category,
    difficulty,
    status: 'cleared',
    stars: Math.max(stars, existing?.stars || 0),
    bestScore: Math.max(score, existing?.bestScore || 0),
    bestReturn: Math.max(ret, existing?.bestReturn || 0),
    attempts: (existing?.attempts || 0) + 1,
    lastPlayTime: new Date().toISOString(),
  };
  const newLevels = { ...data.levels, [levelId]: updated };
  const levelsCleared = Object.values(newLevels).filter(l => l.status === 'cleared').length;
  return {
    ...data,
    levels: newLevels,
    stats: {
      ...data.stats,
      levelsCleared,
      xp: data.stats.xp + Math.floor(score / 10) + stars * 5,
    },
  };
}

// 更新专项训练进度
export function updateSpecialProgress(
  data: TrainingData,
  moduleId: string,
  correct: boolean,
): TrainingData {
  const existing = data.specialTraining[moduleId] || {
    moduleId, currentQuestion: 0, correctCount: 0, totalCount: 0, bestScore: 0,
  };
  const newCorrect = correct ? existing.correctCount + 1 : existing.correctCount;
  const newTotal = existing.totalCount + 1;
  const newConsecutive = correct ? data.stats.consecutiveCorrect + 1 : 0;
  const newMaxConsecutive = Math.max(newConsecutive, data.stats.maxConsecutiveCorrect);
  return {
    ...data,
    specialTraining: {
      ...data.specialTraining,
      [moduleId]: {
        ...existing,
        currentQuestion: existing.currentQuestion + 1,
        correctCount: newCorrect,
        totalCount: newTotal,
        bestScore: Math.max(existing.bestScore, Math.round(newCorrect / newTotal * 100)),
        lastPlayTime: new Date().toISOString(),
      },
    },
    stats: {
      ...data.stats,
      totalCorrect: data.stats.totalCorrect + (correct ? 1 : 0),
      totalTrades: data.stats.totalTrades + 1,
      consecutiveCorrect: newConsecutive,
      maxConsecutiveCorrect: newMaxConsecutive,
      xp: data.stats.xp + (correct ? 3 : 0),
    },
  };
}

// 检查成就解锁
export function checkAchievements(data: TrainingData): Achievement[] {
  const achievements = [...data.achievements];
  const stats = data.stats;
  const levels = data.levels;
  const unlock = (id: string) => {
    const ach = achievements.find(a => a.id === id);
    if (ach && !ach.unlocked) {
      ach.unlocked = true;
      ach.unlockedAt = new Date().toISOString();
    }
  };
  if (stats.levelsCleared >= 1) unlock('first_win');
  if (stats.maxConsecutiveCorrect >= 10) unlock('ten_wins');
  if (stats.maxConsecutiveCorrect >= 50) unlock('fifty_wins');
  if (stats.totalReturn >= 10) unlock('profitable');
  const categories = new Set(Object.values(levels).filter(l => l.status === 'cleared').map(l => l.category));
  if (categories.size >= Object.keys(CATEGORY_VARIETIES).length) unlock('all_categories');
  if (Object.values(levels).some(l => l.stars >= 3)) unlock('perfect_score');
  const masterCleared = Object.values(levels).filter(l => l.difficulty === 4 && l.status === 'cleared');
  const masterTotal = generateLevels().filter(l => l.difficulty === 4).length;
  if (masterCleared.length >= masterTotal && masterTotal > 0) unlock('black_belt');
  const rankInfo = getRankInfo(stats.xp);
  if (rankInfo.rank >= 10) unlock('level_10');
  if (rankInfo.rank >= 20) unlock('level_20');
  if (stats.levelsCleared >= 100) unlock('century');
  return achievements;
}

// ============ 错题收集 ============

export async function saveErrorQuestion(error: ErrorQuestion): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ERROR_KEY);
    const errors: ErrorQuestion[] = raw ? JSON.parse(raw) : [];
    errors.push(error);
    if (errors.length > 200) errors.splice(0, errors.length - 200);
    await AsyncStorage.setItem(ERROR_KEY, JSON.stringify(errors));
  } catch (e) {
    console.error('[Training] save error question error:', e);
  }
}

export async function loadErrorQuestions(): Promise<ErrorQuestion[]> {
  try {
    const raw = await AsyncStorage.getItem(ERROR_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[Training] load error questions error:', e);
    return [];
  }
}

export async function clearErrorQuestions(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ERROR_KEY);
  } catch (e) {
    console.error('[Training] clear error questions error:', e);
  }
}

// ============ 交易历史记录（信号验证） ============

export interface TradeHistoryEntry {
  id: string;
  varietyCode: string;
  varietyName: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  signalScore: number;
  signalGrade: string;
  alwaysInAligned: boolean;
  timestamp: string;
}

const TRADE_HISTORY_KEY = '@brooks_trade_history';
const MAX_HISTORY = 100;

export async function saveTradeHistory(entry: TradeHistoryEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(TRADE_HISTORY_KEY);
    const list: TradeHistoryEntry[] = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
    await AsyncStorage.setItem(TRADE_HISTORY_KEY, JSON.stringify(list));
  } catch (e) { /* ignore */ }
}

export async function loadTradeHistory(): Promise<TradeHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(TRADE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
