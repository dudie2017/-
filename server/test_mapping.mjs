import axios from 'axios';
import fs from 'fs';

const envContent = fs.readFileSync('.env', 'utf-8');
const token = envContent.match(/^TUSHARE_TOKEN\s*=\s*["']?([^"'\n]+)["']?$/m)[1].trim();

const resp = await axios.post('https://api.tushare.pro', {
  api_name: 'fut_mapping',
  token,
  params: { ts_code: 'CU.SHF', start_date: '20000101', end_date: '20261231' },
  fields: 'ts_code,trade_date,mapping_ts_code'
}, { timeout: 30000 });

console.log('code:', resp.data?.code);
console.log('msg:', resp.data?.msg);
if (resp.data?.code === 0) {
  const items = resp.data.data?.items || [];
  console.log('items count:', items.length);
  console.log('fields:', resp.data.data?.fields);
  if (items.length > 0) {
    console.log('first 3:', JSON.stringify(items.slice(0,3)));
    console.log('last 3:', JSON.stringify(items.slice(-3)));
  }
} else {
  console.log('完整返回:', JSON.stringify(resp.data).slice(0, 500));
}
