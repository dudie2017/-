/**
 * Risk Management Module
 * Based on Thorp-Simons roundtable consensus:
 * - Multi-layer stop loss (single/daily/weekly/monthly)
 * - Circuit breaker mechanism
 * - Position sizing (Fixed → Risk Parity → Fractional Kelly)
 * - Correlation monitoring
 */

// ============================================================
// Multi-Layer Stop Loss System
// ============================================================

export interface StopLossConfig {
  maxSingleLossPct: number;     // 单笔最大亏损比例 (default 2%)
  maxDailyLossPct: number;      // 单日最大亏损比例 (default 3%)
  maxWeeklyLossPct: number;     // 单周最大亏损比例 (default 5%)
  maxMonthlyLossPct: number;    // 单月最大亏损比例 (default 10%)
  maxConsecutiveLosses: number; // 连续止损次数 → 熔断 (default 3)
  cooldownHours: number;        // 熔断冷却时间 (default 24h)
}

export interface TradeRecord {
  id: string;
  code: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  size: number;
  pnl: number;
  isLoss: boolean;
  timestamp: number;
  stopType?: string;
}

export interface StopLossCheck {
  triggered: boolean;
  checks: Array<{
    level: string;
    triggered: boolean;
    message: string;
    value: number;
    limit: number;
  }>;
  circuitBreakerActive: boolean;
  circuitBreakerReason?: string;
  circuitBreakerExpiresAt?: number;
}

const DEFAULT_STOP_CONFIG: StopLossConfig = {
  maxSingleLossPct: 0.02,
  maxDailyLossPct: 0.03,
  maxWeeklyLossPct: 0.05,
  maxMonthlyLossPct: 0.10,
  maxConsecutiveLosses: 3,
  cooldownHours: 24,
};

export class StopLossManager {
  private config: StopLossConfig;
  private trades: TradeRecord[] = [];
  private consecutiveLosses = 0;
  private circuitBreakerUntil = 0;

  constructor(config?: Partial<StopLossConfig>) {
    this.config = { ...DEFAULT_STOP_CONFIG, ...config };
  }

  /**
   * Check all stop loss layers
   */
  check(capital: number, currentOpenPnl: number): StopLossCheck {
    const now = Date.now();
    const checks: StopLossCheck['checks'] = [];

    // 1. Single trade stop
    const singleLossPct = Math.abs(Math.min(0, currentOpenPnl)) / capital;
    checks.push({
      level: 'single',
      triggered: currentOpenPnl < 0 && singleLossPct > this.config.maxSingleLossPct,
      message: `单笔亏损 ${(singleLossPct * 100).toFixed(2)}%`,
      value: singleLossPct,
      limit: this.config.maxSingleLossPct,
    });

    // 2. Daily stop
    const dailyPnl = this.getPnlForPeriod(now, 24 * 60 * 60 * 1000);
    const dailyLossPct = Math.abs(Math.min(0, dailyPnl)) / capital;
    checks.push({
      level: 'daily',
      triggered: dailyPnl < 0 && dailyLossPct > this.config.maxDailyLossPct,
      message: `日亏损 ${(dailyLossPct * 100).toFixed(2)}%`,
      value: dailyLossPct,
      limit: this.config.maxDailyLossPct,
    });

    // 3. Weekly stop
    const weeklyPnl = this.getPnlForPeriod(now, 7 * 24 * 60 * 60 * 1000);
    const weeklyLossPct = Math.abs(Math.min(0, weeklyPnl)) / capital;
    checks.push({
      level: 'weekly',
      triggered: weeklyPnl < 0 && weeklyLossPct > this.config.maxWeeklyLossPct,
      message: `周亏损 ${(weeklyLossPct * 100).toFixed(2)}%`,
      value: weeklyLossPct,
      limit: this.config.maxWeeklyLossPct,
    });

    // 4. Monthly stop
    const monthlyPnl = this.getPnlForPeriod(now, 30 * 24 * 60 * 60 * 1000);
    const monthlyLossPct = Math.abs(Math.min(0, monthlyPnl)) / capital;
    checks.push({
      level: 'monthly',
      triggered: monthlyPnl < 0 && monthlyLossPct > this.config.maxMonthlyLossPct,
      message: `月亏损 ${(monthlyLossPct * 100).toFixed(2)}%`,
      value: monthlyLossPct,
      limit: this.config.maxMonthlyLossPct,
    });

    // 5. Circuit breaker
    const circuitBreakerActive = now < this.circuitBreakerUntil;
    checks.push({
      level: 'circuit_breaker',
      triggered: this.consecutiveLosses >= this.config.maxConsecutiveLosses || circuitBreakerActive,
      message: circuitBreakerActive
        ? `熔断中，连续${this.consecutiveLosses}笔止损，${Math.ceil((this.circuitBreakerUntil - now) / 3600000)}小时后恢复`
        : `连续止损 ${this.consecutiveLosses}/${this.config.maxConsecutiveLosses}`,
      value: this.consecutiveLosses,
      limit: this.config.maxConsecutiveLosses,
    });

    const anyTriggered = checks.some(c => c.triggered);

    return {
      triggered: anyTriggered,
      checks,
      circuitBreakerActive,
      circuitBreakerExpiresAt: circuitBreakerActive ? this.circuitBreakerUntil : undefined,
    };
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade: TradeRecord): void {
    this.trades.push(trade);

    if (trade.isLoss) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        this.circuitBreakerUntil = Date.now() + this.config.cooldownHours * 3600000;
      }
    } else {
      this.consecutiveLosses = 0;
      this.circuitBreakerUntil = 0;
    }
  }

  /**
   * Get PnL for a time period
   */
  private getPnlForPeriod(now: number, periodMs: number): number {
    const cutoff = now - periodMs;
    return this.trades
      .filter(t => t.timestamp >= cutoff)
      .reduce((sum, t) => sum + t.pnl, 0);
  }

  /**
   * Get risk summary
   */
  getSummary(capital: number, currentOpenPnl: number) {
    const check = this.check(capital, currentOpenPnl);
    const now = Date.now();

    return {
      capital,
      currentOpenPnl,
      consecutiveLosses: this.consecutiveLosses,
      circuitBreakerActive: check.circuitBreakerActive,
      circuitBreakerExpiresAt: check.circuitBreakerExpiresAt,
      dailyPnl: this.getPnlForPeriod(now, 24 * 60 * 60 * 1000),
      weeklyPnl: this.getPnlForPeriod(now, 7 * 24 * 60 * 60 * 1000),
      monthlyPnl: this.getPnlForPeriod(now, 30 * 24 * 60 * 60 * 1000),
      totalTrades: this.trades.length,
      winRate: this.trades.length > 0
        ? this.trades.filter(t => !t.isLoss).length / this.trades.length
        : 0,
      stopChecks: check.checks,
      canTrade: !check.triggered,
    };
  }

  /**
   * Reset all counters
   */
  reset(): void {
    this.trades = [];
    this.consecutiveLosses = 0;
    this.circuitBreakerUntil = 0;
  }
}

// ============================================================
// Position Sizing Module
// ============================================================

export type PositionMethod = 'fixed' | 'risk_parity' | 'kelly';

export interface PositionSignal {
  code: string;
  direction: 'LONG' | 'SHORT';
  signalStrength: number;  // 0-100
  breakoutScore: number;   // 0-5
  historicalWinRate?: number;
  historicalAvgWin?: number;
  historicalAvgLoss?: number;
  atr: number;
  price: number;
  spectrumState: string;   // '趋势' | '通道' | '区间'
}

export interface PositionResult {
  code: string;
  direction: 'LONG' | 'SHORT';
  size: number;
  riskAmount: number;
  riskPct: number;
  method: PositionMethod;
  kellyFraction?: number;
  stopDistance: number;
  targetDistance: number;
}

export class PositionSizer {
  private method: PositionMethod;
  private capital: number;
  private maxRiskPerTrade: number; // max % of capital risked per trade

  constructor(capital: number, method: PositionMethod = 'fixed', maxRiskPerTrade = 0.02) {
    this.capital = capital;
    this.method = method;
    this.maxRiskPerTrade = maxRiskPerTrade;
  }

  /**
   * Calculate position size based on signal
   */
  calcSize(signal: PositionSignal): PositionResult {
    switch (this.method) {
      case 'fixed':
        return this.fixedSize(signal);
      case 'risk_parity':
        return this.riskParitySize(signal);
      case 'kelly':
        return this.kellySize(signal);
      default:
        return this.fixedSize(signal);
    }
  }

  /**
   * Fixed position: risk ≤ 2% per trade
   * Adjusted by signal strength and spectrum state
   */
  private fixedSize(signal: PositionSignal): PositionResult {
    const stopDistance = 2 * signal.atr;
    const targetDistance = 3 * signal.atr;

    // Base risk
    let riskPct = this.maxRiskPerTrade;

    // Adjust by signal strength (stronger signal → more risk)
    const strengthMultiplier = 0.5 + (signal.signalStrength / 100) * 0.5; // 0.5x to 1.0x
    riskPct *= strengthMultiplier;

    // Adjust by spectrum state
    const spectrumMultiplier = signal.spectrumState === '趋势' ? 1.0
      : signal.spectrumState === '通道' ? 0.7
      : 0.4; // 区间 market → reduce position
    riskPct *= spectrumMultiplier;

    // Adjust by breakout score
    if (signal.breakoutScore >= 4) {
      riskPct *= 1.2;
    } else if (signal.breakoutScore <= 2) {
      riskPct *= 0.6;
    }

    const riskAmount = this.capital * riskPct;
    const size = Math.max(1, Math.floor(riskAmount / stopDistance));

    return {
      code: signal.code,
      direction: signal.direction,
      size,
      riskAmount: size * stopDistance,
      riskPct: (size * stopDistance) / this.capital,
      method: 'fixed',
      stopDistance,
      targetDistance,
    };
  }

  /**
   * Risk Parity: equal risk contribution per position
   * Higher volatility → smaller position
   */
  private riskParitySize(signal: PositionSignal): PositionResult {
    const vol = signal.atr / signal.price;
    const riskBudget = this.capital * this.maxRiskPerTrade;
    const stopDistance = 2 * signal.atr;

    // Inverse volatility weighting
    const size = Math.max(1, Math.floor(riskBudget / (vol * signal.price)));

    return {
      code: signal.code,
      direction: signal.direction,
      size,
      riskAmount: size * stopDistance,
      riskPct: (size * stopDistance) / this.capital,
      method: 'risk_parity',
      stopDistance,
      targetDistance: 3 * signal.atr,
    };
  }

  /**
   * Fractional Kelly (1/4 Kelly)
   * Only use when historical data is available
   */
  private kellySize(signal: PositionSignal): PositionResult {
    const winRate = signal.historicalWinRate ?? 0.55;
    const avgWin = signal.historicalAvgWin ?? 2.0;
    const avgLoss = signal.historicalAvgLoss ?? 1.0;

    const b = avgWin / avgWin; // profit factor
    const p = winRate;
    const q = 1 - p;

    // Full Kelly fraction
    const fullKelly = p - q / b;
    // Use 1/4 Kelly for safety
    const kellyFraction = Math.max(0, Math.min(fullKelly * 0.25, 0.25));

    const stopDistance = 2 * signal.atr;
    const kellyRisk = this.capital * kellyFraction;
    const size = Math.max(1, Math.floor(kellyRisk / stopDistance));

    return {
      code: signal.code,
      direction: signal.direction,
      size,
      riskAmount: size * stopDistance,
      riskPct: (size * stopDistance) / this.capital,
      method: 'kelly',
      kellyFraction,
      stopDistance,
      targetDistance: 3 * signal.atr,
    };
  }

  /**
   * Batch calculate positions for multiple signals
   * Ensures total risk doesn't exceed limits
   */
  calcBatch(signals: PositionSignal[]): PositionResult[] {
    const results = signals.map(s => this.calcSize(s));

    // Check total risk
    const totalRisk = results.reduce((sum, r) => sum + r.riskAmount, 0);
    const maxTotalRisk = this.capital * 0.10; // Max 10% total risk

    if (totalRisk > maxTotalRisk) {
      // Scale down proportionally
      const scale = maxTotalRisk / totalRisk;
      return results.map(r => ({
        ...r,
        size: Math.max(1, Math.floor(r.size * scale)),
        riskAmount: Math.max(1, Math.floor(r.size * scale * r.stopDistance)),
        riskPct: r.riskPct * scale,
      }));
    }

    return results;
  }

  setMethod(method: PositionMethod): void {
    this.method = method;
  }

  setCapital(capital: number): void {
    this.capital = capital;
  }
}

// ============================================================
// Correlation Monitor
// ============================================================

export interface CorrelationResult {
  pairs: Array<{
    code1: string;
    code2: string;
    correlation: number;
    riskLevel: 'low' | 'medium' | 'high';
  }>;
  clusterWarnings: Array<{
    codes: string[];
    avgCorrelation: number;
    message: string;
  }>;
  matrix: Record<string, Record<string, number>>;
}

export class CorrelationMonitor {
  private lookback: number;
  private returnHistory: Map<string, number[]> = new Map();

  constructor(lookback = 60) {
    this.lookback = lookback;
  }

  /**
   * Update return history for a variety
   */
  update(code: string, dailyReturn: number): void {
    if (!this.returnHistory.has(code)) {
      this.returnHistory.set(code, []);
    }
    const history = this.returnHistory.get(code)!;
    history.push(dailyReturn);
    if (history.length > this.lookback) {
      history.shift();
    }
  }

  /**
   * Calculate correlation matrix
   */
  getCorrelationMatrix(codes: string[]): Record<string, Record<string, number>> {
    const matrix: Record<string, Record<string, number>> = {};

    for (const c1 of codes) {
      matrix[c1] = {};
      for (const c2 of codes) {
        if (c1 === c2) {
          matrix[c1][c2] = 1.0;
        } else {
          matrix[c1][c2] = this.calcCorrelation(c1, c2);
        }
      }
    }

    return matrix;
  }

  /**
   * Check for cluster risk in positions
   */
  checkClusterRisk(positions: string[], threshold = 0.7): CorrelationResult {
    const matrix = this.getCorrelationMatrix(positions);
    const pairs: CorrelationResult['pairs'] = [];
    const clusterWarnings: CorrelationResult['clusterWarnings'] = [];

    // Find high-correlation pairs
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const corr = matrix[positions[i]][positions[j]];
        if (!isNaN(corr)) {
          pairs.push({
            code1: positions[i],
            code2: positions[j],
            correlation: corr,
            riskLevel: Math.abs(corr) > 0.8 ? 'high' : Math.abs(corr) > 0.5 ? 'medium' : 'low',
          });
        }
      }
    }

    // Find clusters (groups with avg correlation > threshold)
    const highCorrPairs = pairs.filter(p => Math.abs(p.correlation) > threshold);
    if (highCorrPairs.length > 0) {
      // Group connected codes
      const clusterCodes = new Set<string>();
      highCorrPairs.forEach(p => {
        clusterCodes.add(p.code1);
        clusterCodes.add(p.code2);
      });

      const codesArray = Array.from(clusterCodes);
      let totalCorr = 0;
      let count = 0;
      for (let i = 0; i < codesArray.length; i++) {
        for (let j = i + 1; j < codesArray.length; j++) {
          totalCorr += Math.abs(matrix[codesArray[i]][codesArray[j]]);
          count++;
        }
      }

      if (count > 0) {
        clusterWarnings.push({
          codes: codesArray,
          avgCorrelation: totalCorr / count,
          message: `发现${codesArray.length}个品种高度相关(平均相关系数${(totalCorr / count).toFixed(2)})，存在聚集风险`,
        });
      }
    }

    return { pairs, clusterWarnings, matrix };
  }

  private calcCorrelation(code1: string, code2: string): number {
    const h1 = this.returnHistory.get(code1);
    const h2 = this.returnHistory.get(code2);

    if (!h1 || !h2) return NaN;

    const minLen = Math.min(h1.length, h2.length);
    if (minLen < 10) return NaN;

    const a1 = h1.slice(-minLen);
    const a2 = h2.slice(-minLen);

    const mean1 = a1.reduce((s, v) => s + v, 0) / minLen;
    const mean2 = a2.reduce((s, v) => s + v, 0) / minLen;

    let cov = 0, var1 = 0, var2 = 0;
    for (let i = 0; i < minLen; i++) {
      const d1 = a1[i] - mean1;
      const d2 = a2[i] - mean2;
      cov += d1 * d2;
      var1 += d1 * d1;
      var2 += d2 * d2;
    }

    const denom = Math.sqrt(var1 * var2);
    return denom === 0 ? 0 : cov / denom;
  }

  /**
   * Reset all history
   */
  reset(): void {
    this.returnHistory.clear();
  }
}

// ============================================================
// Export singleton instances
// ============================================================

export const stopLossManager = new StopLossManager();
export const correlationMonitor = new CorrelationMonitor();
