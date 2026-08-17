import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../src/services/backtestEngine';

const CACHE = path.join(process.cwd(), 'data-cache-30m-long');
const ALL = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

(async () => {
  console.log('starting...');
  const r = await runBacktest({
    startCapital: 500000,
    maxPositionPct: 0.15,
    minSignalGrade: 'L3',
    maxHoldDays: 70,
    warmupBars: 120,
    cooldownBars: 28,
    dataDir: CACHE,
    codes: ALL,
  });
  console.log('RESULT:' + JSON.stringify(r.summary));
})().catch((e) => {
  console.error('ERR:' + (e as Error).message);
  process.exit(1);
});
