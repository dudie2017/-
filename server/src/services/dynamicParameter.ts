/**
 * 动态参数调整器
 * 基于强化学习的参数优化框架
 */

export interface ParameterState {
  code: string;
  currentParams: {
    atrPeriod: number;
    holdPeriod: number;
    stopAtrMult: number;
    targetAtrMult: number;
  };
  marketState: {
    volatility: string;
    trend: string;
  };
  performance: {
    recentReturn: number;
    recentDrawdown: number;
    winRate: number;
  };
}

export interface ParameterAction {
  type: 'increase' | 'decrease' | 'keep';
  param: 'atrPeriod' | 'holdPeriod' | 'stopAtrMult' | 'targetAtrMult';
  magnitude: number;
}

export interface ParameterReward {
  score: number;
  components: {
    returnScore: number;
    riskScore: number;
    stabilityScore: number;
  };
}

/**
 * 参数调整策略（基于规则的强化学习代理）
 */
export class ParameterAgent {
  private learningRate: number = 0.1;
  private discountFactor: number = 0.95;
  // Q-learning 探索参数
  private epsilon: number = 0.3;
  private epsilonDecay: number = 0.995;
  private minEpsilon: number = 0.05;
  // Q 表：stateKey -> (actionKey -> qValue)
  private qTable: Map<string, Map<string, number>> = new Map();

  private static readonly PARAMS = [
    'atrPeriod',
    'holdPeriod',
    'stopAtrMult',
    'targetAtrMult',
  ] as const;

  private static readonly TYPES = ['increase', 'decrease', 'keep'] as const;

  /**
   * 状态离散化：把连续市场/表现映射为有限状态键
   */
  private stateKey(state: ParameterState): string {
    const vol = state.marketState.volatility;
    const trend = state.marketState.trend;
    const winRate = state.performance.winRate;
    const dd = state.performance.recentDrawdown;
    const winBin =
      winRate < 0.35 ? 'w0' : winRate < 0.45 ? 'w1' : winRate < 0.55 ? 'w2' : 'w3';
    const ddBin = dd < 0.08 ? 'd0' : dd < 0.15 ? 'd1' : 'd2';
    return `${vol}|${trend}|${winBin}|${ddBin}`;
  }

  private getQ(stateKey: string, actionKey: string): number {
    return this.qTable.get(stateKey)?.get(actionKey) ?? 0;
  }

  private setQ(stateKey: string, actionKey: string, value: number): void {
    if (!this.qTable.has(stateKey)) {
      this.qTable.set(stateKey, new Map());
    }
    this.qTable.get(stateKey)!.set(actionKey, value);
  }

  private maxQ(stateKey: string): number {
    const m = this.qTable.get(stateKey);
    if (!m || m.size === 0) return 0;
    return Math.max(...Array.from(m.values()));
  }

  /**
   * 根据市场状态和表现选择动作（ε-greedy）
   */
  selectAction(state: ParameterState): ParameterAction[] {
    const key = this.stateKey(state);
    const actions: ParameterAction[] = [];

    for (const param of ParameterAgent.PARAMS) {
      let type: ParameterAction['type'];

      if (Math.random() < this.epsilon) {
        // 探索：随机选一个动作类型
        const types = ParameterAgent.TYPES as readonly string[];
        type = types[Math.floor(Math.random() * types.length)] as ParameterAction['type'];
      } else {
        // 利用：选 Q 值最大的动作
        let best: ParameterAction['type'] = 'keep';
        let bestQ = -Infinity;
        for (const t of ParameterAgent.TYPES) {
          const v = this.getQ(key, `${param}:${t}`);
          if (v > bestQ) {
            bestQ = v;
            best = t as ParameterAction['type'];
          }
        }
        type = best;
      }

      if (type === 'keep') continue;
      const magnitude = param === 'holdPeriod' ? 5 : 0.5;
      actions.push({ type, param, magnitude });
    }

    return actions;
  }
  
  /**
   * 执行动作并返回新参数
   */
  executeAction(
    currentParams: ParameterState['currentParams'],
    action: ParameterAction
  ): ParameterState['currentParams'] {
    const newParams = { ...currentParams };
    const value = newParams[action.param];
    
    if (action.type === 'increase') {
      newParams[action.param] = value + action.magnitude;
    } else if (action.type === 'decrease') {
      newParams[action.param] = Math.max(1, value - action.magnitude);
    }
    
    return newParams;
  }
  
  /**
   * 计算奖励
   */
  calculateReward(state: ParameterState): ParameterReward {
    // 缺失字段兜底，防止 NaN 污染 Q 表
    const recentReturn = state.performance.recentReturn ?? 0;
    const recentDrawdown = state.performance.recentDrawdown ?? 0;
    const winRate = state.performance.winRate ?? 0.5;

    // 收益得分（0-1）
    const returnScore = Math.min(1, Math.max(0, (recentReturn + 0.1) / 0.3));

    // 风险得分（0-1，回撤越小越好）
    const riskScore = Math.min(1, Math.max(0, 1 - recentDrawdown / 0.2));

    // 稳定性得分（0-1，胜率越接近 0.5 越好）
    const stabilityScore = 1 - Math.abs(winRate - 0.5) * 2;

    const score = returnScore * 0.4 + riskScore * 0.4 + stabilityScore * 0.2;

    return {
      score,
      components: {
        returnScore,
        riskScore,
        stabilityScore,
      },
    };
  }
  
  /**
   * 更新策略（贝尔曼方程：Q(s,a) = Q(s,a) + α[r + γ·max_a' Q(s',a') − Q(s,a)]）
   */
  updatePolicy(
    state: ParameterState,
    action: ParameterAction,
    reward: ParameterReward,
    nextState?: ParameterState
  ): void {
    const stateKey = this.stateKey(state);
    const actionKey = `${action.param}:${action.type}`;
    const nextKey = nextState ? this.stateKey(nextState) : stateKey;

    const currentQ = this.getQ(stateKey, actionKey);
    const target = reward.score + this.discountFactor * this.maxQ(nextKey);
    this.setQ(stateKey, actionKey, currentQ + this.learningRate * (target - currentQ));

    // 探索率随学习逐步衰减
    this.epsilon = Math.max(this.minEpsilon, this.epsilon * this.epsilonDecay);
  }
}

/**
 * 动态参数优化服务
 */
export class DynamicParameterService {
  private agent: ParameterAgent;
  private stateHistory: Map<string, ParameterState[]> = new Map();
  
  constructor() {
    this.agent = new ParameterAgent();
  }
  
  /**
   * 获取优化后的参数
   */
  getOptimizedParams(
    code: string,
    currentParams: ParameterState['currentParams'],
    marketState: ParameterState['marketState'],
    performance: ParameterState['performance']
  ): ParameterState['currentParams'] {
    const state: ParameterState = {
      code,
      currentParams,
      marketState,
      performance,
    };
    
    // 选择动作
    const actions = this.agent.selectAction(state);
    
    // 执行动作
    let newParams = { ...currentParams };
    for (const action of actions) {
      newParams = this.agent.executeAction(newParams, action);
    }
    
    // 执行动作后的新状态（用于 Q-learning 的状态转移）
    const nextState: ParameterState = {
      ...state,
      currentParams: newParams,
    };

    // 计算奖励
    const reward = this.agent.calculateReward(nextState);

    // 对每个动作执行贝尔曼更新
    for (const action of actions) {
      this.agent.updatePolicy(state, action, reward, nextState);
    }
    
    // 记录历史
    if (!this.stateHistory.has(code)) {
      this.stateHistory.set(code, []);
    }
    this.stateHistory.get(code)!.push(state);
    
    return newParams;
  }
  
  /**
   * 获取学习曲线
   */
  getLearningCurve(code: string): ParameterReward[] {
    const history = this.stateHistory.get(code) || [];
    return history.map(state => this.agent.calculateReward(state));
  }
}

// 全局服务实例
let dynamicParameterService: DynamicParameterService | null = null;

/**
 * 获取动态参数服务实例
 */
export function getDynamicParameterService(): DynamicParameterService {
  if (!dynamicParameterService) {
    dynamicParameterService = new DynamicParameterService();
  }
  return dynamicParameterService;
}
