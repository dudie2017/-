import express from 'express';
import multer from 'multer';
import { HeaderUtils, ASRClient, Config } from 'coze-coding-dev-sdk';
import * as ai from '../services/aiAssistant.js';
import * as externalData from '../services/externalDataService.js';
import { getDb } from '../services/database.js';
import { VARIETIES } from '../services/varieties.js';
import { searchVarietyNews, formatNewsForContext } from '../services/newsService.js';
import { getScanCache } from './scan.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * 检测用户消息是否涉及需要外部数据的品种
 */
function detectVarietyFromMessage(message: string): string | null {
  const varietyMap: Record<string, string> = {
    '原油': 'SC', '石油': 'SC', 'oil': 'SC', 'crude': 'SC',
    '铜': 'CU', '沪铜': 'CU', 'copper': 'CU',
    '铝': 'AL', '沪铝': 'AL', 'aluminum': 'AL',
    '黄金': 'AU', '沪金': 'AU', 'gold': 'AU',
    '白银': 'AG', '沪银': 'AG', 'silver': 'AG',
    '铁矿': 'I', '铁矿石': 'I', 'iron': 'I',
    '螺纹': 'RB', '螺纹钢': 'RB', 'rebar': 'RB',
    '焦煤': 'JM', 'coking': 'JM',
    '焦炭': 'J', 'coke': 'J',
    '豆粕': 'M', '大豆': 'M', 'soybean': 'M',
    '鸡蛋': 'JD', '蛋': 'JD', 'egg': 'JD',
    '生猪': 'LH', '猪': 'LH', 'hog': 'LH',
    '棉花': 'CF', 'cotton': 'CF',
    '棕榈油': 'P', 'palm': 'P',
    '橡胶': 'RU', 'rubber': 'RU',
    '纯碱': 'SA', 'soda': 'SA',
    '玻璃': 'FG', 'glass': 'FG',
    'PTA': 'TA', 'pta': 'TA',
    '甲醇': 'MA', 'methanol': 'MA',
    'PVC': 'V', 'pvc': 'V',
    'PP': 'PP', '聚丙烯': 'PP',
    'PE': 'L', '聚乙烯': 'L',
  };

  for (const [keyword, code] of Object.entries(varietyMap)) {
    if (message.toLowerCase().includes(keyword.toLowerCase())) {
      return code;
    }
  }
  return null;
}

/**
 * POST /api/v1/ai/chat
 * 非流式聊天接口 (JSON)
 * Body: { message: string, context?: string, history?: Array<{role: string, content: string}> }
 */
router.post('/chat', async (req: express.Request, res: express.Response) => {
  try {
    const { message, context, history } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '消息不能为空' });
    }

    // 检测用户是否询问特定品种，自动获取外部数据
    const varietyCode = detectVarietyFromMessage(message);
    let externalContext = '';

    if (varietyCode) {
      try {
        const data = await externalData.getExternalDataForVariety(varietyCode);
        externalContext = externalData.formatExternalDataForAI(data, varietyCode);
      } catch (err) {
        console.warn('获取外部数据失败:', err);
      }
    }

    // 构建消息列表
    const messages: Array<{ role: string; content: string }> = [];

    // 添加外部数据上下文
    if (externalContext) {
      messages.push({
        role: 'system',
        content: `【外部数据补充】\n${externalContext}\n\n请结合以上外部数据回答用户问题。`,
      });
    }

    // 如果有上下文，添加系统消息
    if (context) {
      messages.push({
        role: 'system',
        content: `当前市场上下文：\n${context}`,
      });
    }

    // 添加对话历史（最近10条）
    if (history && Array.isArray(history)) {
      const recentHistory = history.slice(-10);
      for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    // 添加当前用户消息
    messages.push({
      role: 'user',
      content: message,
    });

    // 提取转发头
    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);

    // 非流式输出
    const content = await ai.chat(messages, customHeaders);

    res.json({
      success: true,
      data: {
        content,
        role: 'assistant',
      },
    });
  } catch (error) {
    console.error('AI chat error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/ai/upload-image
 * 上传图片接口
 * Body: multipart/form-data with 'image' field
 */
router.post('/upload-image', upload.single('image'), async (req: express.Request, res: express.Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传图片' });
    }

    // 将图片保存到临时目录
    const fs = await import('fs');
    const path = await import('path');
    const tempDir = '/tmp/ai-images';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const filename = `${Date.now()}-${req.file.originalname}`;
    const filepath = path.join(tempDir, filename);
    fs.writeFileSync(filepath, req.file.buffer);

    // 返回图片 URL（本地文件路径）
    const imageUrl = `/tmp/ai-images/${filename}`;

    res.json({
      success: true,
      data: { url: imageUrl, filename },
    });
  } catch (error) {
    console.error('图片上传失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/ai/chat/stream
 * 流式聊天接口 (SSE)
 * Body: { message: string, context?: string, imageUrl?: string }
 */
router.post('/chat/stream', async (req: express.Request, res: express.Response) => {
  try {
    const { message, context, imageUrl } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '消息不能为空' });
    }

    // 构建消息列表
    const messages: Array<{ role: string; content: any }> = [];

    // 如果有上下文，添加系统消息
    if (context) {
      messages.push({
        role: 'system',
        content: `当前市场上下文：\n${context}`,
      });
    }

    // 添加用户消息（支持图片）
    if (imageUrl) {
      // 多模态消息：文本 + 图片
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: message },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      });
    } else {
      // 纯文本消息
      messages.push({
        role: 'user',
        content: message,
      });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 提取转发头
    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);

    // 流式输出
    const stream = ai.chatStream(messages, customHeaders);

    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // 发送结束标记
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('AI chat error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI 服务调用失败' });
    } else {
      // 如果 SSE 已经启动，发送错误消息给客户端
      const errorMsg = error instanceof Error ? error.message : 'AI 服务调用失败';
      res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

/**
 * POST /api/v1/ai/enhanced-chat
 * 增强版对话：注入完整数据上下文 + 验证重试机制
 * Body: { message: string, varietyCode: string, history?: Array<{role: string, content: string}> }
 */
router.post('/enhanced-chat', async (req: express.Request, res: express.Response) => {
  try {
    const { message, varietyCode, history = [] } = req.body;

    if (!message || !varietyCode) {
      return res.status(400).json({ error: '消息和品种代码不能为空' });
    }

    // 1. 获取品种完整数据（从缓存获取，包含 ADX 等完整数据）
    const cachedScan = getScanCache();
    if (!cachedScan) {
      return res.status(503).json({ error: '扫描数据未就绪，请先运行扫描' });
    }
    const scanRow = cachedScan.rows.find((r: any) => r.code === varietyCode);
    if (!scanRow) {
      return res.status(404).json({ error: '品种数据不存在' });
    }

    // 2. 获取价格行为摘要数据（轻量版，用于对话）
    const priceActionData = ai.getPriceActionSummary(varietyCode, scanRow);

    // 3. 获取新闻
    let newsContext = '';
    try {
      const news = await searchVarietyNews(varietyCode);
      newsContext = formatNewsForContext(news);
    } catch (e) {
      console.log('新闻搜索失败，继续对话');
    }

    // 4. 构建数据上下文
    const dataContext = ai.buildDataContext(varietyCode, scanRow, priceActionData);

    // 5. 构建对话历史（注入数据上下文）
    const enhancedHistory = [
      { role: 'system' as const, content: dataContext },
      ...history,
      { role: 'user' as const, content: message }
    ];

    // 6. 生成回答（带验证重试）- 使用 priceActionData 作为 paSummary
    const result = await ai.chatWithValidation(message, varietyCode, scanRow, priceActionData);
    const response = result.content;
    const validated = result.valid;

    // 7. 返回结果
    res.json({
      success: true,
      response,
      validated,
      attempts: result.attempts,
      errors: result.errors,
      varietyCode,
      varietyName: scanRow.name
    });

  } catch (error: any) {
    console.error('Enhanced chat error:', error);
    res.status(500).json({ error: '对话服务调用失败' });
  }
});

/**
 * POST /api/v1/ai/analyze-variety
 * 分析特定品种
 * Body: { varietyCode: string }
 */
router.post('/analyze-variety', async (req: express.Request, res: express.Response) => {
  try {
    const { varietyCode } = req.body;

    if (!varietyCode) {
      return res.status(400).json({ error: '品种代码不能为空' });
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
    const result = await ai.analyzeVariety(varietyCode, customHeaders);

    res.json({
      success: true,
      data: {
        varietyCode,
        analysis: result
      }
    });
  } catch (error) {
    console.error('AI analyze variety error:', error);
    res.status(500).json({ error: '品种分析失败' });
  }
});

/**
 * POST /api/v1/ai/chat-sync
 * 非流式聊天接口（同步返回完整结果）
 * Body: { messages: Array<{ role: string, content: string }> }
 */
router.post('/chat-sync', async (req: express.Request, res: express.Response) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '消息列表不能为空' });
    }

    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
    const result = await ai.chat(messages, customHeaders);

    res.json({
      success: true,
      data: {
        content: result
      }
    });
  } catch (error) {
    console.error('AI chat sync error:', error);
    res.status(500).json({ error: 'AI 服务调用失败' });
  }
});

/**
 * POST /api/v1/ai/transcribe
 * 语音转文字接口
 * Body: FormData with 'file' field
 */
router.post('/transcribe', upload.single('file'), async (req: express.Request, res: express.Response) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: '请上传音频文件' });
    }

    // 将文件转换为 base64
    const audioBase64 = file.buffer.toString('base64');

    // 使用 ASR 客户端进行语音识别
    const config = new Config();
    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
    const client = new ASRClient(config, customHeaders);

    const result = await client.recognize({
      uid: 'user',
      base64Data: audioBase64,
    });

    res.json({
      success: true,
      data: {
        text: result.text,
        duration: result.duration,
      }
    });
  } catch (error) {
    console.error('AI transcribe error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '语音识别失败'
    });
  }
});

export default router;
