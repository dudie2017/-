/**
 * 风险预警检测服务
 * 检测品种突破关键位、波动率异常、相关性突变
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AlertRule {
  id: string;
  type: 'breakout' | 'volatility' | 'correlation';
  code: string;
  threshold: number;
  enabled: boolean;
}

interface Alert {
  id: string;
  ruleId: string;
  type: 'breakout' | 'volatility' | 'correlation';
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high';
  timestamp: string;
  data: any;
}

const ALERTS_FILE = path.join(__dirname, '../data/risk_alerts.json');
const RULES_FILE = path.join(__dirname, '../data/alert_rules.json');

/**
 * 加载预警规则
 */
export function loadAlertRules(): AlertRule[] {
  if (!fs.existsSync(RULES_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * 保存预警规则
 */
export function saveAlertRules(rules: AlertRule[]): void {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

/**
 * 加载历史预警
 */
export function loadAlerts(): Alert[] {
  if (!fs.existsSync(ALERTS_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * 保存历史预警
 */
export function saveAlerts(alerts: Alert[]): void {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

/**
 * 添加预警规则
 */
export function addAlertRule(rule: Omit<AlertRule, 'id'>): AlertRule {
  const rules = loadAlertRules();
  const newRule: AlertRule = {
    ...rule,
    id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
  };
  rules.push(newRule);
  saveAlertRules(rules);
  return newRule;
}

/**
 * 删除预警规则
 */
export function deleteAlertRule(ruleId: string): boolean {
  const rules = loadAlertRules();
  const filtered = rules.filter((r) => r.id !== ruleId);
  if (filtered.length === rules.length) {
    return false;
  }
  saveAlertRules(filtered);
  return true;
}

/**
 * 检测突破关键位
 */
function detectBreakout(code: string, threshold: number): Alert | null {
  const filePath = path.join(__dirname, '../../data-cache', `${code}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars = data.bars || [];
    if (bars.length < 20) {
      return null;
    }

    // 计算最近20日的最高价和最低价
    const recent20 = bars.slice(-20);
    const high20 = Math.max(...recent20.map((b: any) => b.h));
    const low20 = Math.min(...recent20.map((b: any) => b.l));

    const latest = bars[bars.length - 1];
    const latestClose = latest.c;

    // 检测突破
    if (latestClose > high20 * (1 + threshold / 100)) {
      return {
        id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ruleId: '',
        type: 'breakout',
        code,
        message: `${code} 突破20日高点 ${high20.toFixed(2)}，当前价 ${latestClose.toFixed(2)}`,
        severity: 'high',
        timestamp: new Date().toISOString(),
        data: { high20, latestClose,突破幅度: ((latestClose - high20) / high20 * 100).toFixed(2) + '%' },
      };
    }

    if (latestClose < low20 * (1 - threshold / 100)) {
      return {
        id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ruleId: '',
        type: 'breakout',
        code,
        message: `${code} 跌破20日低点 ${low20.toFixed(2)}，当前价 ${latestClose.toFixed(2)}`,
        severity: 'high',
        timestamp: new Date().toISOString(),
        data: { low20, latestClose, 跌破幅度: ((low20 - latestClose) / low20 * 100).toFixed(2) + '%' },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 检测波动率异常
 */
function detectVolatility(code: string, threshold: number): Alert | null {
  const filePath = path.join(__dirname, '../../data-cache', `${code}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars = data.bars || [];
    if (bars.length < 30) {
      return null;
    }

    // 计算最近30日的日收益率
    const returns: number[] = [];
    for (let i = 1; i < 30; i++) {
      const prev = bars[bars.length - 30 + i - 1].c;
      const curr = bars[bars.length - 30 + i].c;
      returns.push((curr - prev) / prev);
    }

    // 计算波动率（标准差）
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // 年化波动率

    // 如果波动率超过阈值，触发预警
    if (volatility > threshold) {
      return {
        id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ruleId: '',
        type: 'volatility',
        code,
        message: `${code} 波动率异常，当前年化波动率 ${volatility.toFixed(2)}%，阈值 ${threshold}%`,
        severity: volatility > threshold * 1.5 ? 'high' : 'medium',
        timestamp: new Date().toISOString(),
        data: { volatility: volatility.toFixed(2), threshold },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 运行所有预警检测
 */
export function runAlertDetection(): Alert[] {
  const rules = loadAlertRules().filter((r) => r.enabled);
  const newAlerts: Alert[] = [];

  for (const rule of rules) {
    let alert: Alert | null = null;

    switch (rule.type) {
      case 'breakout':
        alert = detectBreakout(rule.code, rule.threshold);
        break;
      case 'volatility':
        alert = detectVolatility(rule.code, rule.threshold);
        break;
      case 'correlation':
        // TODO: 实现相关性突变检测
        break;
    }

    if (alert) {
      alert.ruleId = rule.id;
      newAlerts.push(alert);
    }
  }

  // 保存新预警
  if (newAlerts.length > 0) {
    const existingAlerts = loadAlerts();
    const allAlerts = [...newAlerts, ...existingAlerts].slice(0, 100); // 最多保留100条
    saveAlerts(allAlerts);
  }

  return newAlerts;
}
