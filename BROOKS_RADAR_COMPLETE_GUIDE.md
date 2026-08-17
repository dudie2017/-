# Brooks Radar - 期货量化分析系统完整复刻指南

## 一、项目概述

**Brooks Radar** 是一个基于 Brooks 价格行为理论的期货量化分析系统，采用"三线合一"决策框架：
- **供需面**（五维评分）
- **利润信号**（成本线偏离）
- **Brooks技术面**（Always In方向）

---

## 二、技术架构

### 2.1 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | Expo 54 + React Native | 移动端 + Web 兼容 |
| 后端 | Express.js + TypeScript | RESTful API |
| 数据库 | PostgreSQL + Drizzle ORM | 数据存储 |
| 数据源 | 大商所API + Tushare + AKShare | 多源数据 |

### 2.2 项目结构

```
brooks-radar/
├── client/                    # React Native 前端
│   ├── app/                   # Expo Router 路由
│   │   ├── (tabs)/            # Tab 导航
│   │   │   ├── index.tsx      # 首页（市场概览）
│   │   │   ├── research.tsx   # 研究
│   │   │   ├── trading.tsx    # 交易
│   │   │   ├── alerts.tsx     # 预警
│   │   │   ├── ai-assistant.tsx  # AI助手
│   │   │   └── optimization.tsx  # 优化
│   │   ├── detail.tsx         # 详情页
│   │   └── _layout.tsx        # 根布局
│   ├── screens/               # 页面实现
│   ├── components/            # 可复用组件
│   └── package.json
├── server/                    # Express 后端
│   ├── src/
│   │   ├── index.ts           # 入口文件
│   │   ├── db.ts              # 数据库连接
│   │   ├── routes/            # API 路由
│   │   │   ├── scan.ts        # 扫描服务
│   │   │   ├── scoring.ts     # 评分引擎
│   │   │   ├── technical.ts   # 技术分析
│   │   │   ├── dceApi.ts      # 大商所API
│   │   │   ├── tushare.ts     # Tushare数据
│   │   │   └── akshare.ts     # AKShare数据
│   │   └── services/          # 业务逻辑
│   │       ├── scanner.ts     # 扫描器
│   │       ├── scoringEngine.ts  # 评分引擎
│   │       ├── brooksScoring.ts  # Brooks评分
│   │       ├── indicators.ts  # 技术指标
│   │       ├── varieties.ts   # 品种配置
│   │       ├── dceApiService.ts  # 大商所服务
│   │       ├── tushareService.ts # Tushare服务
│   │       └── akshareService.ts # AKShare服务
│   └── package.json
└── package.json               # 根配置
```

---

## 三、核心算法

### 3.1 Brooks Always In 方向

```typescript
function alwaysInDirection(bars: BarData[]): {
  direction: string; flip: boolean; ema20: number; emaDevPct: number; aiStreak: number;
} {
  if (bars.length < 25) return { direction: '数据不足', flip: false, ema20: 0, emaDevPct: 0, aiStreak: 0 };

  const closes = bars.map((b) => b.c);
  const ema20Arr = calcEMA(closes, 20);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const ema20 = ema20Arr[bars.length - 1];
  const prevEma20 = ema20Arr[bars.length - 2];

  // AI方向：价格 > EMA20 为多头，否则为空头
  const aiNow = last.c > ema20 ? 'LONG' : 'SHORT';
  const aiPrev = prev.c > prevEma20 ? 'LONG' : 'SHORT';
  const flip = aiNow !== aiPrev;
  const emaDev = ((last.c / ema20) - 1) * 100;

  // 计算连续持仓天数
  let aiCount = 1;
  for (let i = bars.length - 2; i >= Math.max(bars.length - 20, 0); i--) {
    const curAi = bars[i].c > ema20Arr[i] ? 'LONG' : 'SHORT';
    if (curAi === aiNow) aiCount++;
    else break;
  }

  return { direction: aiNow, flip, ema20: Math.round(ema20 * 100) / 100, emaDevPct: Math.round(emaDev * 100) / 100, aiStreak: aiCount };
}
```

### 3.2 五维评分算法

```typescript
export function calculateFiveDimensionScore(input: ScoringInput): FiveDimensionScore {
  const config = VARIETY_CONFIGS[input.code];
  
  const price = calculatePriceScore(input.closePrice, config.costLine, config.elasticity);
  const profit = calculateProfitScore(input.profitRate);
  const basis = calculateBasisScore(input.basisRate);
  const inventory = calculateInventoryScore(input.inventoryPct);
  const demand = calculateDemandScore(input.demandStatus);
  
  let total: number;
  if (config.elasticity === 'invalid_cost') {
    // 成本线无意义的品种（贵金属等），4维换算到100分制
    total = (profit + basis + inventory + demand) / 80 * 100;
  } else {
    total = price + profit + basis + inventory + demand;
  }
  
  // 方向判断
  let direction: FiveDimensionScore['direction'];
  if (total > 70) direction = '多';
  else if (total > 55) direction = '偏多';
  else if (total > 40) direction = '震荡';
  else if (total > 25) direction = '偏空';
  else direction = '空';
  
  // 仓位档位
  let position: number;
  if (total >= 70) position = 4;
  else if (total >= 55) position = 3;
  else if (total >= 40) position = 2;
  else if (total >= 25) position = 1;
  else position = 0;
  
  return { price, profit, basis, inventory, demand, total, direction, position };
}

// 价格得分计算
function calculatePriceScore(closePrice: number, costLine: number | null, elasticity: SupplyElasticity): number {
  if (costLine === null || elasticity === 'invalid_cost') return 10;
  
  const deviation = (closePrice - costLine) / costLine;
  
  if (elasticity === 'normal') {
    if (deviation < -0.20) return 20;  // 深度亏损
    if (deviation < -0.10) return 16;
    if (deviation < 0) return 12;
    if (deviation < 0.10) return 8;
    if (deviation < 0.20) return 4;
    return 0;  // 高利润
  } else {
    // 供给刚性品种修正
    if (deviation < -0.20) return 20;
    if (deviation < -0.10) return 16;
    if (deviation < 0) return 12;
    if (deviation < 0.10) return 10;
    if (deviation < 0.20) return 8;
    if (deviation < 0.40) return 6;
    return 4;
  }
}
```

### 3.3 品种成本线配置

```typescript
export const VARIETY_CONFIGS: Record<string, VarietyConfig> = {
  // 黑色系
  'RB': { code: 'RB', name: '螺纹钢', exchange: 'SHFE', category: '黑色', costLine: 4200, elasticity: 'normal' },
  'I': { code: 'I', name: '铁矿石', exchange: 'DCE', category: '黑色', costLine: 800, elasticity: 'normal' },
  'JM': { code: 'JM', name: '焦煤', exchange: 'DCE', category: '黑色', costLine: 1800, elasticity: 'normal' },
  'J': { code: 'J', name: '焦炭', exchange: 'DCE', category: '黑色', costLine: null, elasticity: 'normal' },
  'HC': { code: 'HC', name: '热卷', exchange: 'SHFE', category: '黑色', costLine: 4200, elasticity: 'normal' },
  
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
  
  // 贵金属（成本线无意义）
  'AU': { code: 'AU', name: '沪金', exchange: 'SHFE', category: '贵金属', costLine: null, elasticity: 'invalid_cost' },
  'AG': { code: 'AG', name: '沪银', exchange: 'SHFE', category: '贵金属', costLine: null, elasticity: 'invalid_cost' },
  
  // 新材料
  'SI': { code: 'SI', name: '工业硅', exchange: 'GFEX', category: '新材料', costLine: 9500, elasticity: 'normal' },
  'LC': { code: 'LC', name: '碳酸锂', exchange: 'GFEX', category: '新材料', costLine: 80000, elasticity: 'normal' },
};
```

---

## 四、数据源配置

### 4.1 大商所官方API

**申请地址**: https://www.dce.com.cn/dceapi/

**API Key**: `<YOUR_DCE_API_KEY>`  
**API Secret**: `<YOUR_DCE_API_SECRET>`

> ⚠️ **安全提示**: 请将实际的API密钥配置在 `server/.env` 文件中，切勿提交到代码仓库！

**接口列表**:
| 接口 | 路径 | 说明 |
|------|------|------|
| 登录 | POST /dceapi/cms/auth/accessToken | 获取Token |
| 日行情 | POST /dceapi/forward/publicweb/dailystat/dayQuotes | 获取日行情 |
| 夜盘行情 | POST /dceapi/forward/publicweb/dailystat/tiNightQuotes | 获取夜盘行情 |

**示例代码**:
```typescript
// 登录获取Token
const loginResponse = await fetch('http://www.dce.com.cn/dceapi/cms/auth/accessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
  body: JSON.stringify({ secret: API_SECRET }),
});
const { data: { token } } = await loginResponse.json();

// 获取日行情
const dailyResponse = await fetch('http://www.dce.com.cn/dceapi/forward/publicweb/dailystat/dayQuotes', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'apikey': API_KEY,
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    varietyId: 'm',  // 豆粕
    tradeDate: '20260717',
    tradeType: '1',
    lang: 'zh',
    statisticsType: 2,
  }),
});
```

### 4.2 Tushare数据

**申请地址**: https://tushare.pro/

**Token**: `<YOUR_TUSHARE_TOKEN>`

> ⚠️ **安全提示**: 请将实际的Token配置在 `server/.env` 文件中，切勿提交到代码仓库！

**权限**: 5000积分（日线数据）

**接口列表**:
| 接口 | API名称 | 说明 |
|------|---------|------|
| 期货日线 | fut_daily | 获取期货日线数据 |
| 期货分钟 | ft_mins | 需额外付费1000元 |

**示例代码**:
```typescript
const response = await fetch('https://api.tushare.pro', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    api_name: 'fut_daily',
    token: TUSHARE_TOKEN,
    params: { ts_code: 'AG2506.SHF' },
    fields: 'ts_code,trade_date,open,high,low,close,vol,oi',
  }),
});
```

### 4.3 AKShare数据（免费）

**安装**: `pip3 install akshare`

**数据源**: 新浪财经

**示例代码**:
```python
import akshare as ak

# 获取白银主力合约5分钟数据
df = ak.futures_zh_minute_sina(symbol='ag0', period='5')
print(f'数据条数: {len(df)}')
```

---

## 五、API接口文档

### 5.1 核心接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/scan | 全品种扫描 |
| GET | /api/v1/scan/:code | 单品种扫描 |
| GET | /api/v1/scoring | 全品种评分 |
| GET | /api/v1/technical/:code | 技术分析 |
| GET | /api/v1/variety | 品种列表 |

### 5.2 数据源接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/dce/status | 大商所API状态 |
| GET | /api/v1/dce/daily?variety=M | 大商所日行情 |
| GET | /api/v1/tushare/futures-daily?variety=AG2506.SHF | Tushare日线 |
| GET | /api/v1/akshare/futures-mins?symbol=ag0&period=5 | AKShare分钟线 |
| GET | /api/v1/akshare/resonance?variety_code=AG | 多周期共振 |

### 5.3 响应示例

**扫描结果**:
```json
{
  "success": true,
  "total": 65,
  "results": [
    {
      "code": "AG",
      "name": "白银",
      "ai_direction": "LONG",
      "trend_label": "趋势",
      "trend_strength": 65,
      "signals": ["MTR(次要)趋势反转(多)", "熊市楔形(注意:与AI多头矛盾)"],
      "spectrum": "趋势"
    }
  ]
}
```

---

## 六、依赖列表

### 6.1 Server端

```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2.x",
    "axios": "^1.x",
    "cors": "^2.x",
    "dayjs": "^1.x",
    "dotenv": "^16.x",
    "drizzle-orm": "^0.x",
    "drizzle-zod": "^0.x",
    "express": "^4.x",
    "iconv-lite": "^0.x",
    "multer": "^1.x",
    "node-cron": "^3.x",
    "pg": "^8.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/cors": "^2.x",
    "@types/express": "^4.x",
    "@types/multer": "^1.x",
    "@types/node-cron": "^3.x",
    "@types/pg": "^8.x",
    "drizzle-kit": "^0.x",
    "esbuild": "^0.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

### 6.2 Client端

```json
{
  "dependencies": {
    "@expo/vector-icons": "^14.x",
    "@react-native-async-storage/async-storage": "^2.x",
    "dayjs": "^1.x",
    "expo": "^54.x",
    "expo-router": "^5.x",
    "react": "^19.x",
    "react-native": "^0.79.x",
    "react-native-reanimated": "^3.x",
    "react-native-safe-area-context": "^5.x",
    "react-native-sse": "^1.x",
    "zod": "^3.x"
  }
}
```

---

## 七、部署指南

### 7.1 环境要求

- Node.js >= 18
- PostgreSQL >= 14
- Python >= 3.8（AKShare）

### 7.2 安装步骤

```bash
# 1. 克隆项目
git clone <repo-url>
cd brooks-radar

# 2. 安装依赖
pnpm install

# 3. 配置环境变量
cat > server/.env << EOF
DB_HOST=localhost
DB_PORT=5432
DB_NAME=brooks_radar
DB_USER=postgres
DB_PASSWORD=postgres
# 请替换为你自己的密钥
TUSHARE_TOKEN=<YOUR_TUSHARE_TOKEN>
DCE_API_KEY=<YOUR_DCE_API_KEY>
DCE_API_SECRET=<YOUR_DCE_API_SECRET>
EOF

# 4. 创建数据库
createdb brooks_radar

# 5. 初始化数据库
cd server && pnpm run db:migrate

# 6. 安装Python依赖（AKShare）
pip3 install akshare

# 7. 启动服务
cd .. && pnpm dev
```

### 7.3 服务端口

| 服务 | 端口 |
|------|------|
| 前端（Expo Web） | 5000 |
| 后端（Express） | 9091 |

---

## 八、品种配置

### 8.1 66个期货品种

```typescript
export const VARIETIES: Record<string, string> = {
  // 上期所 (19个)
  CU0: '铜', AL0: '铝', ZN0: '锌', NI0: '镍', SN0: '锡', PB0: '铅',
  AU0: '黄金', AG0: '白银',
  RB0: '螺纹钢', HC0: '热卷', SS0: '不锈钢', SP0: '纸浆',
  FU0: '燃油', BU0: '沥青', RU0: '橡胶', NR0: '20号胶', AO0: '氧化铝',
  
  // 上期能源 (4个)
  SC0: '原油', LU0: '低硫燃油', BC0: '国际铜', EC0: '集运欧线',
  
  // 大商所 (16个)
  I0: '铁矿石', JM0: '焦煤', J0: '焦炭',
  M0: '豆粕', Y0: '豆油', A0: '豆一', P0: '棕榈油', C0: '玉米',
  LH0: '生猪', JD0: '鸡蛋', CS0: '淀粉',
  L0: '塑料', V0: 'PVC', PP0: '聚丙烯', EB0: '苯乙烯', PG0: '液化气',
  
  // 郑商所 (17个)
  CF0: '棉花', SR0: '白糖', AP0: '苹果',
  SA0: '纯碱', FG0: '玻璃',
  TA0: 'PTA', EG0: '乙二醇', MA0: '甲醇', OI0: '菜油', RM0: '菜粕',
  CJ0: '红枣', SF0: '硅铁', SM0: '锰硅', UR0: '尿素', PK0: '花生',
  PF0: '短纤', PX0: '对二甲苯', SH0: '烧碱',
  
  // 中金所-股指 (4个)
  IF0: '沪深300', IH0: '上证50', IC0: '中证500', IM0: '中证1000',
  
  // 中金所-国债 (4个)
  T0: '10年国债', TF0: '5年国债', TS0: '2年国债', TL0: '30年国债',
  
  // 广期所 (2个)
  SI0: '工业硅', LC0: '碳酸锂',
};
```

### 8.2 品种分组

```typescript
export const VARIETY_GROUPS: Record<string, { members: string[]; leader: string }> = {
  '黑色系': { members: ['RB0', 'HC0', 'I0', 'J0', 'JM0'], leader: 'I0' },
  '有色金属': { members: ['CU0', 'AL0', 'ZN0', 'NI0', 'SN0', 'PB0'], leader: 'CU0' },
  '贵金属': { members: ['AU0', 'AG0'], leader: 'AU0' },
  '能化链': { members: ['SC0', 'BU0', 'TA0', 'MA0', 'EG0', 'PP0', 'L0', 'V0', 'FU0', 'NR0', 'RU0'], leader: 'SC0' },
  '农产品': { members: ['A0', 'M0', 'Y0', 'OI0', 'RM0', 'C0', 'CS0', 'CF0', 'SR0', 'AP0', 'JD0', 'LH0'], leader: 'M0' },
  '建材': { members: ['FG0', 'SA0'], leader: 'SA0' },
  '股指': { members: ['IF0', 'IH0', 'IC0', 'IM0'], leader: 'IF0' },
  '国债': { members: ['T0', 'TF0', 'TS0', 'TL0'], leader: 'T0' },
  '新材料': { members: ['LC0', 'SI0'], leader: 'LC0' },
};
```

---

## 九、核心文件清单

| 文件 | 行数 | 说明 |
|------|------|------|
| server/src/services/scanner.ts | 1800+ | 扫描器核心 |
| server/src/services/scoringEngine.ts | 700+ | 评分引擎 |
| server/src/services/brooksScoring.ts | 500+ | Brooks评分 |
| server/src/services/indicators.ts | 400+ | 技术指标 |
| server/src/services/varieties.ts | 200+ | 品种配置 |
| server/src/routes/scan.ts | 738 | 扫描API |
| client/screens/market/index.tsx | 500+ | 市场页面 |

---

## 十、注意事项

1. **数据源优先级**: 大商所API > AKShare > Tushare
2. **分钟数据**: Tushare需要额外付费，建议使用免费的AKShare
3. **品种成本线**: 贵金属（AU/AG）成本线无意义，使用4维评分
4. **供给弹性**: 有色、橡胶等品种供给刚性，评分需修正

---

*文档生成时间: 2026-07-18*
