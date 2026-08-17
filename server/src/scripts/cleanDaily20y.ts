/**
 * 数据清洗脚本：20 年日线缓存换月标记
 *
 * 背景：Tushare 主连（如 CU.SHF）在换月日通常只有 close，o/h/l 为 null。
 * 这些日子是主连切换产生的"伪交易日"，会污染冲击扫描统计。
 *
 * 处理：
 * 1. 删除 c 为 null/0/NaN 的无交易空行（Tushare 主连在无成交日返回全 null，
 *    这些伪交易日会污染 zigzag 摆动计算，导致收益爆炸）
 * 2. 将 o/h/l 为 null 但 c 有效的条目标记 rollover: true（换月日）
 * 3. 用 close 填充 o/h/l，保证数值运算不报错（但统计时排除 rollover 日）
 * 4. 重新计算每根 K 线的收益率 ret = close/prevClose - 1
 * 5. 输出清洗统计报告
 *
 * 运行：npx tsx src/scripts/cleanDaily20y.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

interface Bar {
  date: string;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number;
  vol: number | null;
  hold: number | null;
  rollover?: boolean;
  ret?: number | null;
}

function main() {
  const files = fs.readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('_rollover'))
    .sort();
  let totalBars = 0;
  let totalRemoved = 0;
  let totalRollover = 0;
  const summary: string[] = [];

  for (const file of files) {
    const code = file.replace('.json', '');
    const filePath = path.join(CACHE_DIR, file);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars: Bar[] = Array.isArray(raw) ? raw : raw.bars || [];

    let removedCount = 0;
    let rolloverCount = 0;

    // 第一阶段：删除 c 无效的无交易空行，填充换月日 OHLC
    const cleaned: Bar[] = [];
    for (const b of bars) {
      if (b.c === null || b.c === undefined || !isFinite(b.c) || b.c <= 0) {
        removedCount++;
        continue;
      }
      const isRollover = b.o === null || b.h === null || b.l === null;
      if (isRollover) {
        // 用 close 填充 OHLC，标记换月
        b.o = b.c;
        b.h = b.c;
        b.l = b.c;
        b.rollover = true;
        rolloverCount++;
      }
      cleaned.push(b);
    }

    // 第二阶段：基于删除后的连续价格序列重算收益率
    let prevClose: number | null = null;
    for (const b of cleaned) {
      if (prevClose !== null && prevClose > 0) {
        b.ret = b.c / prevClose - 1;
      } else {
        b.ret = null;
      }
      prevClose = b.c;
    }

    if (cleaned.length === 0) {
      console.log(`[SKIP] ${code}: 清洗后为空，跳过写回`);
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(cleaned), 'utf-8');
    totalBars += cleaned.length;
    totalRemoved += removedCount;
    totalRollover += rolloverCount;
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    summary.push(
      `${code.padEnd(6)} 总${String(cleaned.length).padStart(5)} 删空行${String(removedCount).padStart(4)} 换月${String(rolloverCount).padStart(4)} ` +
      `${first.date} ~ ${last.date}`
    );
  }

  console.log('===== 20 年日线清洗报告 =====');
  summary.forEach((s) => console.log(s));
  console.log('==============================');
  console.log(`总K线: ${totalBars} | 删除空行: ${totalRemoved} | 换月日: ${totalRollover}`);
  console.log('清洗完成：无交易空行已删除，换月日已标记 rollover=true，收益率已重算');
}

main();
