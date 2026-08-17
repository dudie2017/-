/**
 * AKShare 数据源服务
 * 
 * 通过 Python 子进程调用 AKShare 获取期货分钟数据
 * AKShare 是免费的开源库，支持期货分钟线数据
 */

import { spawn } from 'child_process';

export interface AKShareBar {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 通过 Python 调用 AKShare 获取期货分钟数据
 */
async function fetchFuturesMinutesAKShare(
  symbol: string,
  period: string = '5'
): Promise<AKShareBar[]> {
  // symbol 格式转换: AG2506.SHF -> ag2506
  const akSymbol = symbol.split('.')[0].toLowerCase();
  
  const pythonScript = `
import akshare as ak
import json
import sys

try:
    # 获取期货分钟数据
    df = ak.futures_zh_minute_sina(symbol="${akSymbol}", period="${period}")
    
    # 转换为 JSON 格式
    result = []
    for _, row in df.iterrows():
        result.append({
            "datetime": str(row.get("datetime", "")),
            "open": float(row.get("open", 0)),
            "high": float(row.get("high", 0)),
            "low": float(row.get("low", 0)),
            "close": float(row.get("close", 0)),
            "volume": float(row.get("volume", 0))
        })
    
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['-c', pythonScript]);
    
    let stdout = '';
    let stderr = '';
    
    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    python.on('close', (code) => {
      if (code !== 0) {
        console.error(`AKShare Python script failed: ${stderr}`);
        reject(new Error(`AKShare script failed: ${stderr}`));
        return;
      }
      
      try {
        const data = JSON.parse(stdout.trim());
        if (data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data);
        }
      } catch (e) {
        reject(new Error(`Failed to parse AKShare output: ${stdout}`));
      }
    });
  });
}

/**
 * 检查 AKShare 是否可用
 */
export async function checkAKShareAvailability(): Promise<{
  available: boolean;
  python: boolean;
  akshare: boolean;
  message: string;
}> {
  // 检查 Python
  const pythonCheck = new Promise<boolean>((resolve) => {
    const python = spawn('python3', ['--version']);
    python.on('close', (code) => resolve(code === 0));
  });
  
  const hasPython = await pythonCheck;
  if (!hasPython) {
    return {
      available: false,
      python: false,
      akshare: false,
      message: 'Python3 未安装'
    };
  }
  
  // 检查 AKShare
  const akshareCheck = new Promise<boolean>((resolve) => {
    const python = spawn('python3', ['-c', 'import akshare; print(akshare.__version__)']);
    python.on('close', (code) => resolve(code === 0));
  });
  
  const hasAKShare = await akshareCheck;
  
  return {
    available: hasPython && hasAKShare,
    python: hasPython,
    akshare: hasAKShare,
    message: hasAKShare ? 'AKShare 可用' : 'AKShare 未安装，请运行: pip3 install akshare'
  };
}

/**
 * 获取期货分钟数据（使用 AKShare）
 */
export async function getFuturesMinutesAKShare(
  tsCode: string,
  freq: string = '5min'
): Promise<{
  success: boolean;
  data?: AKShareBar[];
  error?: string;
}> {
  try {
    // 频率转换: 5min -> 5
    const period = freq.replace('min', '');
    
    const data = await fetchFuturesMinutesAKShare(tsCode, period);
    
    console.info(`AKShare 获取 ${tsCode} ${freq} 数据成功: ${data.length} 条`);
    
    return {
      success: true,
      data
    };
  } catch (error: any) {
    console.error(`AKShare 获取分钟数据失败: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 获取多周期数据（用于多周期共振分析）
 */
export async function getMultiTimeframeDataAKShare(
  tsCode: string
): Promise<{
  success: boolean;
  data?: {
    m5: AKShareBar[];
    m15: AKShareBar[];
    m60: AKShareBar[];
  };
  error?: string;
}> {
  try {
    const [m5Result, m15Result, m60Result] = await Promise.all([
      getFuturesMinutesAKShare(tsCode, '5min'),
      getFuturesMinutesAKShare(tsCode, '15min'),
      getFuturesMinutesAKShare(tsCode, '60min')
    ]);
    
    if (!m5Result.success || !m15Result.success || !m60Result.success) {
      return {
        success: false,
        error: m5Result.error || m15Result.error || m60Result.error
      };
    }
    
    return {
      success: true,
      data: {
        m5: m5Result.data || [],
        m15: m15Result.data || [],
        m60: m60Result.data || []
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message
    };
  }
}
