#!/usr/bin/env python3
"""
从新浪财经API拉取期货主力合约30分钟K线数据
用于更新 data-cache-30m-long 目录下的缓存文件
"""
import requests
import json
import re
import os
import time
from datetime import datetime

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data-cache-30m-long")

# 品种 -> 活跃合约映射（需定期更新）
# 每个品种列出当前活跃的合约月份，按到期时间排序
ACTIVE_CONTRACTS = {
    # 有色金属（上期所）
    "CU0": ["cu2608", "cu2609", "cu2610", "cu2611", "cu2612"],
    "AL0": ["al2608", "al2609", "al2610", "al2611", "al2612"],
    "ZN0": ["zn2608", "zn2609", "zn2610", "zn2611", "zn2612"],
    "PB0": ["pb2608", "pb2609", "pb2610"],
    "NI0": ["ni2608", "ni2609", "ni2610", "ni2611", "ni2612"],
    "SN0": ["sn2608", "sn2609", "sn2610", "sn2611", "sn2612"],
    "SS0": ["ss2608", "ss2609", "ss2610"],
    "AO0": ["ao2608", "ao2609", "ao2610", "ao2611", "ao2612"],
    # 黑色系
    "RB0": ["rb2608", "rb2609", "rb2610"],
    "HC0": ["hc2608", "hc2609", "hc2610"],
    "I0":  ["i2608", "i2609", "i2610"],
    "J0":  ["j2608", "j2609", "j2610"],
    "JM0": ["jm2608", "jm2609", "jm2610"],
    "SF0": ["sf2608", "sf2609", "sf2610"],
    "SM0": ["sm2608", "sm2609", "sm2610"],
    "FG0": ["fg2608", "fg2609", "fg2610"],
    "SA0": ["sa2608", "sa2609", "sa2610"],
    # 原油化工
    "SC0": ["sc2609", "sc2610", "sc2611", "sc2612"],
    "FU0": ["fu2609", "fu2610", "fu2611"],
    "BU0": ["bu2609", "bu2610", "bu2611", "bu2612"],
    "LU0": ["lu2609", "lu2610", "lu2611", "lu2612"],
    "PG0": ["pg2609", "pg2610", "pg2611", "pg2612"],
    "EB0": ["eb2609", "eb2610", "eb2611", "eb2612"],
    "EG0": ["eg2609", "eg2610"],
    # 聚烯烃/化工
    "L0":  ["l2609", "l2610"],
    "PP0": ["pp2609", "pp2610"],
    "MA0": ["ma2609", "ma2610"],
    "TA0": ["ta2609", "ta2610"],
    "PF0": ["pf2609", "pf2610"],
    "PX0": ["px2609", "px2610"],
    "UR0": ["ur2609", "ur2610"],
    # 农产品
    "M0":  ["m2609", "m2610"],
    "A0":  ["a2609", "a2610"],
    "P0":  ["p2609", "p2610"],
    "RM0": ["rm2609", "rm2610"],
    "CF0": ["cf2609", "cf2610"],
    "SR0": ["sr2609", "sr2610"],
    "C0":  ["c2609", "c2610"],
    "CS0": ["cs2609", "cs2610"],
    "JD0": ["jd2609", "jd2610"],
    "LH0": ["lh2609", "lh2610"],
    "AP0": ["ap2609", "ap2610"],
    "CJ0": ["cj2609", "cj2610"],
    # 贵金属
    "AU0": ["au2608", "au2609", "au2610", "au2612"],
    "AG0": ["ag2608", "ag2609", "ag2610", "ag2611", "ag2612"],
    # 中金所股指
    "IF0": ["if2608", "if2609", "if2610", "if2612"],
    "IC0": ["ic2608", "ic2609", "ic2610", "ic2612"],
    "IM0": ["im2608", "im2609", "im2610", "im2612"],
    "IH0": ["ih2608", "ih2609", "ih2610", "ih2612"],
    # 特殊
    "SP0": ["sp2609", "sp2610"],
    "WR0": ["wr2609", "wr2610"],
    "SI0": ["si2608", "si2609", "si2610", "si2611", "si2612"],
    "LC0": ["lc2608", "lc2609", "lc2610", "lc2611", "lc2612"],
    "SH0": ["sh2608", "sh2609", "sh2610", "sh2611", "sh2612"],
    "EC0": ["ec2608", "ec2610", "ec2612"],
    "BC0": ["bc2609", "bc2610", "bc2611", "bc2612"],
}


def fetch_30min(contract):
    """从新浪API获取30分钟K线数据"""
    url = f'https://stock.finance.sina.com.cn/futures/api/jsonp.php/var%20_{contract}=/InnerFuturesNewService.getFewMinLine?symbol={contract}&type=30'
    try:
        resp = requests.get(url, timeout=15)
        text = resp.text
        match = re.search(r'=\((\[.*\])\)', text, re.DOTALL)
        if not match:
            return []
        data = json.loads(match.group(1))
        bars = []
        for item in data:
            bars.append({
                "date": item.get("d", ""),
                "o": float(item.get("o", 0)),
                "h": float(item.get("h", 0)),
                "l": float(item.get("l", 0)),
                "c": float(item.get("c", 0)),
                "vol": float(item.get("v", 0)),
                "hold": float(item.get("p", 0)),
            })
        return bars
    except Exception as e:
        print(f"  拉取 {contract} 失败: {e}")
        return []


def update_variety(variety, contracts):
    """更新单个品种的缓存"""
    all_bars = []
    for contract in contracts:
        bars = fetch_30min(contract)
        if bars:
            all_bars.extend(bars)
        time.sleep(0.15)  # 限速，避免被封

    if not all_bars:
        return 0

    # 去重排序
    all_bars.sort(key=lambda x: x["date"])
    seen = set()
    unique = []
    for b in all_bars:
        if b["date"] not in seen:
            seen.add(b["date"])
            unique.append(b)

    # 写入缓存
    os.makedirs(CACHE_DIR, exist_ok=True)
    out_path = os.path.join(CACHE_DIR, f"{variety}.json")
    with open(out_path, "w") as f:
        json.dump(unique, f, ensure_ascii=False)

    return len(unique)


def main():
    print(f"=== 期货30分钟K线数据更新 ===")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"缓存目录: {CACHE_DIR}")
    print()

    os.makedirs(CACHE_DIR, exist_ok=True)

    total = len(ACTIVE_CONTRACTS)
    success = 0
    failed = []

    for i, (variety, contracts) in enumerate(ACTIVE_CONTRACTS.items()):
        print(f"[{i+1}/{total}] {variety}...", end=" ", flush=True)
        count = update_variety(variety, contracts)
        if count > 0:
            out_path = os.path.join(CACHE_DIR, f"{variety}.json")
            with open(out_path) as f:
                data = json.load(f)
            latest = data[-1]["date"][:10] if data else "?"
            print(f"OK ({count} bars, latest: {latest})")
            success += 1
        else:
            print("FAILED")
            failed.append(variety)

    print(f"\n=== 完成 ===")
    print(f"成功: {success}/{total}")
    if failed:
        print(f"失败: {', '.join(failed)}")


if __name__ == "__main__":
    main()
