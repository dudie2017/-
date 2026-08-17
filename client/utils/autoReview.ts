/**
 * 复盘自动同步 — 开仓/平仓后自动创建/更新当日品种复盘记录
 */
import { saveVarietyReview } from '@/utils/api';

/** 开仓时自动创建复盘草稿 */
export async function autoReviewOnOpen(
  varietyCode: string,
  varietyName: string,
  direction: 'long' | 'short',
) {
  try {
    const today = new Date().toISOString().split('T')[0];
    await saveVarietyReview(today, {
      variety_code: varietyCode,
      variety_name: varietyName,
      notes: `快捷开仓 — ${direction === 'long' ? '多' : '空'}单`,
    });
  } catch (_) {
    // 复盘记录失败不阻塞主流程
  }
}

/** 平仓时更新复盘盈亏 */
export async function autoReviewOnClose(
  varietyCode: string,
  varietyName: string,
  openPrice: number,
  closePrice: number,
  quantity: number,
  direction: 'long' | 'short',
) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const pnl = direction === 'long'
      ? (closePrice - openPrice) * quantity
      : (openPrice - closePrice) * quantity;
    const pnlPct = openPrice > 0 ? ((pnl / (openPrice * quantity)) * 100) : 0;
    const isWin = pnl > 0;

    await saveVarietyReview(today, {
      variety_code: varietyCode,
      variety_name: varietyName,
      notes: `快捷平仓 — PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(0)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${isWin ? ' ✓' : ' ✗'}，入场 ${openPrice} → 出场 ${closePrice}，手数 ${quantity}`,
    });
  } catch (_) {
    // 复盘记录失败不阻塞主流程
  }
}
