/**
 * 统一日志工具
 *
 * 轻量、零依赖，复用 console 输出（仍进入现有 /app/work/logs 日志体系）。
 * 支持：
 *   - 分级：debug / info / warn / error
 *   - 模块名：便于按模块过滤
 *   - 结构化前缀：ISO 时间戳 + 级别 + 模块名
 *   - 环境变量 LOG_LEVEL 控制阈值（默认 info）
 *
 * 用法：
 *   import { createLogger } from '@/utils/logger';
 *   const log = createLogger('variety-expansion');
 *   log.info('训练完成', { code: 'MA0' });
 *   log.error('回测失败', err);
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function resolveThreshold(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (VALID_LEVELS as string[]).includes(raw) ? (raw as LogLevel) : 'info';
}

function emit(level: LogLevel, module: string, args: unknown[]): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[resolveThreshold()]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
  const writer =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.log;
  writer(prefix, ...args);
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (...args: unknown[]) => emit('debug', module, args),
    info: (...args: unknown[]) => emit('info', module, args),
    warn: (...args: unknown[]) => emit('warn', module, args),
    error: (...args: unknown[]) => emit('error', module, args),
  };
}

export const logger: Logger = createLogger('server');
