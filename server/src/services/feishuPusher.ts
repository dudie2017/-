/**
 * 飞书群机器人 Webhook 消息推送
 * 用于交易机会、止损/反转等提醒的实时推送（手机飞书 App 实时接收）
 * 与 feishuSync.ts（多维表格数据同步）职责分离：这里只负责发消息
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const FEISHU_WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL || '';
const FEISHU_WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET || '';

// 富文本行颜色标签（飞书 post 消息支持）
export const FEISHU_COLOR = {
  red: 'red',
  orange: 'orange',
  green: 'green',
  blue: 'blue',
  cyan: 'cyan',
  grey: 'grey',
  purple: 'purple',
} as const;

/**
 * 计算飞书机器人签名（机器人开启签名校验时需要）
 * 算法：HMAC-SHA256(timestamp + "\n" + secret)，Base64 编码
 */
function genSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', stringToSign);
  return hmac.digest('base64');
}

/**
 * 发送飞书文本消息
 */
export async function pushFeishuText(text: string): Promise<boolean> {
  if (!FEISHU_WEBHOOK_URL) {
    console.warn('[FeishuPusher] FEISHU_WEBHOOK_URL 未配置，跳过推送');
    return false;
  }

  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text },
  };
  if (FEISHU_WEBHOOK_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = genSign(timestamp, FEISHU_WEBHOOK_SECRET);
  }

  try {
    const resp = await fetch(FEISHU_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      console.error(`[FeishuPusher] 推送失败: ${data.msg || JSON.stringify(data)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[FeishuPusher] 推送异常:', (e as Error)?.message || e);
    return false;
  }
}

/**
 * 发送飞书富文本消息（interactive 卡片格式，webhook 正式支持，支持 lark_md 颜色/加粗）
 * @param title 标题
 * @param lines 内容行 [{ text, color? }] color 取值见 FEISHU_COLOR
 * @param extra 附加项：icon 图标、note 灰色脚注、template 卡片主题色
 */
export async function pushFeishuRich(
  title: string,
  lines: Array<{ text: string; color?: string }>,
  extra?: { note?: string; icon?: string; template?: string },
): Promise<boolean> {
  if (!FEISHU_WEBHOOK_URL) {
    console.warn('[FeishuPusher] FEISHU_WEBHOOK_URL 未配置，跳过推送');
    return false;
  }

  const icon = extra?.icon || '';
  const fullTitle = icon ? `${icon} ${title}` : title;
  const template = extra?.template || 'blue';

  // 每行转为 lark_md 文本（支持 **加粗** 与 <font color='x'> 颜色）
  const elements: unknown[] = [];
  for (const line of lines) {
    let md = line.text;
    if (line.color) {
      // 用 <font color> 包裹整行：飞书 lark_md 支持 red/blue/green/grey/orange/purple
      md = `<font color='${line.color}'>${md}</font>`;
    }
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: md },
    });
  }
  if (extra?.note) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `<font color='grey'>${extra.note}</font>` },
    });
  }
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `<font color='grey'>⏰ ${new Date().toLocaleString('zh-CN', { hour12: false })}</font>` },
  });

  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: fullTitle },
        template,
      },
      elements,
    },
  };
  if (FEISHU_WEBHOOK_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = genSign(timestamp, FEISHU_WEBHOOK_SECRET);
  }

  try {
    const resp = await fetch(FEISHU_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      console.error(`[FeishuPusher] 推送失败: ${data.msg || JSON.stringify(data)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[FeishuPusher] 推送异常:', (e as Error)?.message || e);
    return false;
  }
}
