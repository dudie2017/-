/**
 * 板块联动热力图组件
 * 
 * 展示各板块内品种的涨跌情况和联动强度
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import type { SectorHeatmapData, SectorHeatmapSector } from '@/utils/paperTradingApi';

interface Props {
  data: SectorHeatmapData;
}

// 涨跌颜色映射
const getRetColor = (ret: number): string => {
  if (ret > 2) return '#FF4444';
  if (ret > 1) return '#FF6666';
  if (ret > 0.5) return '#FF8888';
  if (ret > 0) return '#FFAAAA';
  if (ret > -0.5) return '#AAFFAA';
  if (ret > -1) return '#88FF88';
  if (ret > -2) return '#66FF66';
  return '#00CC66';
};

// 联动强度颜色
const getStrengthColor = (strength: number): string => {
  if (strength >= 0.8) return '#FFD700';
  if (strength >= 0.6) return '#FFA500';
  if (strength >= 0.4) return '#888888';
  return '#444444';
};

function SectorCard({ sector }: { sector: SectorHeatmapSector }) {
  const strengthColor = getStrengthColor(sector.correlationStrength);
  const directionEmoji = sector.dominantDirection === 'up' ? '↑' : sector.dominantDirection === 'down' ? '↓' : '→';
  const directionColor = sector.dominantDirection === 'up' ? '#FF4444' : sector.dominantDirection === 'down' ? '#00CC66' : '#888888';
  
  return (
    <View style={styles.sectorCard}>
      {/* 板块标题 */}
      <View style={styles.sectorHeader}>
        <Text style={styles.sectorName}>{sector.sector}</Text>
        <View style={[styles.strengthBadge, { backgroundColor: strengthColor }]}>
          <Text style={styles.strengthText}>
            {directionEmoji} {(sector.correlationStrength * 100).toFixed(0)}%
          </Text>
        </View>
      </View>
      
      {/* 品种网格 */}
      <View style={styles.varietyGrid}>
        {sector.varieties.map((v) => (
          <View
            key={v.code}
            style={[styles.varietyCell, { backgroundColor: getRetColor(v.ret) }]}
          >
            <Text style={styles.varietyCode} numberOfLines={1}>
              {v.code.replace(/0$/, '')}
            </Text>
            <Text style={styles.varietyRet}>
              {v.ret > 0 ? '+' : ''}{v.ret.toFixed(1)}%
            </Text>
          </View>
        ))}
      </View>
      
      {/* 统计 */}
      <View style={styles.sectorStats}>
        <Text style={[styles.statText, { color: '#FF4444' }]}>↑{sector.upCount}</Text>
        <Text style={[styles.statText, { color: '#888888' }]}>→{sector.flatCount}</Text>
        <Text style={[styles.statText, { color: '#00CC66' }]}>↓{sector.downCount}</Text>
      </View>
    </View>
  );
}

export function SectorHeatmap({ data }: Props) {
  const sortedSectors = useMemo(() => {
    return [...data.sectors].sort((a, b) => b.correlationStrength - a.correlationStrength);
  }, [data.sectors]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>板块联动热力图</Text>
        <Text style={styles.subtitle}>
          更新于 {new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
      
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.sectorsRow}>
            {sortedSectors.map((sector) => (
              <SectorCard key={sector.sector} sector={sector} />
            ))}
          </View>
        </ScrollView>
      </View>
      
      {/* 图例 */}
      <View style={styles.legend}>
        <Text style={styles.legendTitle}>涨跌幅度</Text>
        <View style={styles.legendRow}>
          <View style={[styles.legendItem, { backgroundColor: '#FF4444' }]} />
          <Text style={styles.legendText}>涨&gt;2%</Text>
          <View style={[styles.legendItem, { backgroundColor: '#FF8888' }]} />
          <Text style={styles.legendText}>涨0.5-2%</Text>
          <View style={[styles.legendItem, { backgroundColor: '#AAFFAA' }]} />
          <Text style={styles.legendText}>跌0-0.5%</Text>
          <View style={[styles.legendItem, { backgroundColor: '#00CC66' }]} />
          <Text style={styles.legendText}>跌&gt;2%</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  header: {
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 12,
    color: '#888888',
    marginTop: 4,
  },
  sectorsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  sectorCard: {
    width: 140,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 12,
  },
  sectorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectorName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  strengthBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  strengthText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#000000',
  },
  varietyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  varietyCell: {
    width: 40,
    height: 36,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  varietyCode: {
    fontSize: 9,
    fontWeight: '600',
    color: '#000000',
  },
  varietyRet: {
    fontSize: 8,
    fontWeight: '500',
    color: '#000000',
  },
  sectorStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  statText: {
    fontSize: 12,
    fontWeight: '600',
  },
  legend: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  legendTitle: {
    fontSize: 12,
    color: '#888888',
    marginBottom: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendItem: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 10,
    color: '#AAAAAA',
  },
});
