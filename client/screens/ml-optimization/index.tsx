/**
 * 机器学习优化页面
 * 包含：模型训练、品种推荐、特征重要性、模型监控与重训练
 */

import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';


interface VarietyRecommendation {
  code: string;
  name: string;
  recommendation: string;
  confidence: number;
  predictedReturn: number;
  predictedDrawdown: number;
  profitFactor: number;
}

interface ModelVersion {
  id: number;
  version: string;
  created_at: string;
  accuracy: number;
  precision_score: number;
  recall_score: number;
  f1_score: number;
  training_samples: number;
  varieties_count: number;
  is_active: boolean;
  performance_decay: number;
}

interface RetrainCheckResult {
  needsRetraining: boolean;
  currentVersion: string | null;
  decay: number;
  decayPercentage: string;
  threshold: number;
  thresholdPercentage: string;
}

export function MLOptimizationContent() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recommendations, setRecommendations] = useState<VarietyRecommendation[]>([]);
  const [featureImportance, setFeatureImportance] = useState<Record<string, number>>({});
  const [trainingStatus, setTrainingStatus] = useState<string>('');
  const [activeVersion, setActiveVersion] = useState<ModelVersion | null>(null);
  const [retrainCheck, setRetrainCheck] = useState<RetrainCheckResult | null>(null);
  const [checkingRetrain, setCheckingRetrain] = useState(false);
  const [retraining, setRetraining] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      // 获取推荐
      const recRes = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/ml-optimization/recommendations`);
      const recData = await recRes.json();

      if (recData.success) {
        setRecommendations(recData.data.recommendations || []);
      }

      // 获取特征重要性
      const featRes = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/ml-optimization/feature-importance`);
      const featData = await featRes.json();

      if (featData.success) {
        setFeatureImportance(featData.data.featureImportance || {});
      }
    } catch (error) {
      console.error('获取 ML 优化数据失败:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchModelStatus = useCallback(async () => {
    try {
      // 获取当前活跃版本
      const activeRes = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/model-monitoring/active`);
      const activeData = await activeRes.json();

      if (activeData.success) {
        setActiveVersion(activeData.data.activeVersion || null);
      }

      // 获取重训练检查结果
      const checkRes = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/model-monitoring/needs-retrain`);
      const checkData = await checkRes.json();

      if (checkData.success) {
        setRetrainCheck(checkData.data);
      }
    } catch (error) {
      console.error('获取模型监控状态失败:', error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
      fetchModelStatus();
    }, [fetchData, fetchModelStatus])
  );

  const handleTrain = async () => {
    try {
      setTrainingStatus('正在训练模型...（约需1分钟）');
      const res = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/ml-optimization/train`, undefined, 120000);
      const data = await res.json();

      if (data.success) {
        setTrainingStatus('模型训练完成！');
        fetchData();
      } else {
        setTrainingStatus('训练失败');
      }
    } catch (error) {
      setTrainingStatus('训练出错');
    }
  };

  /**
   * 服务端文件：server/src/routes/modelMonitoring.ts
   * 接口：GET /api/v1/model-monitoring/needs-retrain
   * Query 参数：threshold?: number（性能衰减阈值，默认 0.1）
   */
  const handleCheckRetrain = async () => {
    try {
      setCheckingRetrain(true);
      const res = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/model-monitoring/needs-retrain`);
      const data = await res.json();

      if (data.success) {
        setRetrainCheck(data.data);
        const needs = data.data.needsRetraining;
        Alert.alert(
          needs ? '建议重训练' : '模型状态良好',
          needs
            ? `性能衰减 ${data.data.decayPercentage}，超过阈值 ${data.data.thresholdPercentage}`
            : `性能衰减 ${data.data.decayPercentage}，未超过阈值 ${data.data.thresholdPercentage}`
        );
      } else {
        Alert.alert('检查失败', data.error || '未知错误');
      }
    } catch (error) {
      Alert.alert('检查出错', '网络错误');
    } finally {
      setCheckingRetrain(false);
    }
  };

  /**
   * 服务端文件：server/src/routes/modelMonitoring.ts
   * 接口：POST /api/v1/model-monitoring/retrain
   * Body 参数：无
   */
  const handleRetrain = async () => {
    try {
      setRetraining(true);
      const res = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/model-monitoring/retrain`, {
        method: 'POST',
      });
      const data = await res.json();

      if (data.success) {
        Alert.alert('重训练完成', `准确率：${(data.data.accuracy * 100).toFixed(2)}%`);
        fetchData();
        fetchModelStatus();
      } else {
        Alert.alert('重训练失败', data.error || '未知错误');
      }
    } catch (error) {
      Alert.alert('重训练出错', '网络错误');
    } finally {
      setRetraining(false);
    }
  };

  const getRecommendationColor = (rec: string) => {
    if (rec === '强烈推荐') return '#10B981';
    if (rec === '推荐') return '#3B82F6';
    if (rec === '观望') return '#F59E0B';
    return '#6B7280';
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('zh-CN');
    } catch {
      return iso;
    }
  };

  return (
    <View className="flex-1 bg-gray-50">
        {/* Header */}
        <View className="bg-white px-4 py-3 border-b border-gray-200">
          <Text className="text-xl font-bold text-gray-900">机器学习优化</Text>
          <Text className="text-sm text-gray-500 mt-1">基于全品种 1000 次实验数据</Text>
        </View>

        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color="#3B82F6" />
          </View>
        ) : (
          <ScrollView
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  fetchData();
                  fetchModelStatus();
                }}
              />
            }
          >
            {/* 模型监控与重训练 */}
            <View className="bg-white p-4 mt-4 mx-4 rounded-lg shadow-sm">
              <Text className="text-lg font-bold text-gray-900 mb-3">模型监控与重训练</Text>

              {/* 当前版本信息 */}
              {activeVersion ? (
                <View className="bg-blue-50 rounded-lg p-3 mb-3">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-sm font-semibold text-blue-900">
                      当前版本：{activeVersion.version}
                    </Text>
                    <View className="bg-blue-500 px-2 py-0.5 rounded">
                      <Text className="text-white text-xs font-medium">活跃</Text>
                    </View>
                  </View>
                  <View className="flex-row flex-wrap gap-x-4 mt-2">
                    <Text className="text-xs text-blue-700">
                      准确率：{(activeVersion.accuracy * 100).toFixed(2)}%
                    </Text>
                    <Text className="text-xs text-blue-700">
                      F1：{activeVersion.f1_score?.toFixed(4) || '0'}
                    </Text>
                    <Text className="text-xs text-blue-700">
                      样本：{activeVersion.training_samples || 0}
                    </Text>
                  </View>
                  <Text className="text-xs text-blue-600 mt-1">
                    训练时间：{formatDate(activeVersion.created_at)}
                  </Text>
                </View>
              ) : (
                <View className="bg-gray-100 rounded-lg p-3 mb-3">
                  <Text className="text-sm text-gray-600">暂无模型版本，请先训练模型</Text>
                </View>
              )}

              {/* 重训练检查结果 */}
              {retrainCheck && (
                <View
                  className={`rounded-lg p-3 mb-3 ${
                    retrainCheck.needsRetraining ? 'bg-orange-50' : 'bg-green-50'
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      retrainCheck.needsRetraining ? 'text-orange-800' : 'text-green-800'
                    }`}
                  >
                    {retrainCheck.needsRetraining ? '建议重训练' : '模型状态良好'}
                  </Text>
                  <Text
                    className={`text-xs mt-1 ${
                      retrainCheck.needsRetraining ? 'text-orange-700' : 'text-green-700'
                    }`}
                  >
                    性能衰减：{retrainCheck.decayPercentage}（阈值 {retrainCheck.thresholdPercentage}）
                  </Text>
                </View>
              )}

              {/* 操作按钮 */}
              <View className="flex-row gap-3">
                <TouchableOpacity
                  onPress={handleCheckRetrain}
                  disabled={checkingRetrain}
                  className="flex-1 bg-blue-500 py-3 px-4 rounded-lg items-center"
                >
                  {checkingRetrain ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text className="text-white font-semibold">检查重训练</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleRetrain}
                  disabled={retraining}
                  className="flex-1 bg-orange-500 py-3 px-4 rounded-lg items-center"
                >
                  {retraining ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text className="text-white font-semibold">执行重训练</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* 训练按钮 */}
            <View className="bg-white p-4 mt-4 mx-4 rounded-lg shadow-sm">
              <TouchableOpacity
                onPress={handleTrain}
                className="bg-blue-500 py-3 px-4 rounded-lg items-center"
              >
                <Text className="text-white font-semibold">快速训练模型</Text>
              </TouchableOpacity>
              {trainingStatus ? (
                <Text className="text-sm text-gray-600 mt-2 text-center">{trainingStatus}</Text>
              ) : null}
            </View>

            {/* 品种推荐 */}
            <View className="bg-white p-4 mt-4 mx-4 rounded-lg shadow-sm">
              <Text className="text-lg font-bold text-gray-900 mb-3">品种推荐</Text>
              {recommendations.length === 0 ? (
                <Text className="text-gray-500">暂无推荐</Text>
              ) : (
                recommendations.map((rec, index) => (
                  <View
                    key={index}
                    className="flex-row items-center py-2 border-b border-gray-100 last:border-0"
                  >
                    <View className="flex-1">
                      <Text className="font-semibold text-gray-900">{rec.code}</Text>
                      <Text className="text-xs text-gray-500">{rec.name}</Text>
                    </View>
                    <View
                      className="px-2 py-1 rounded"
                      style={{ backgroundColor: getRecommendationColor(rec.recommendation) + '20' }}
                    >
                      <Text
                        className="text-xs font-medium"
                        style={{ color: getRecommendationColor(rec.recommendation) }}
                      >
                        {rec.recommendation}
                      </Text>
                    </View>
                    <View className="ml-3 items-end">
                      <Text className="text-sm font-semibold text-gray-900">
                        PF: {rec.profitFactor?.toFixed(2)}
                      </Text>
                      <Text className="text-xs text-gray-500">
                        置信度：{(rec.confidence * 100).toFixed(0)}%
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* 特征重要性 */}
            <View className="bg-white p-4 mt-4 mx-4 mb-4 rounded-lg shadow-sm">
              <Text className="text-lg font-bold text-gray-900 mb-3">特征重要性</Text>
              {Object.keys(featureImportance).length === 0 ? (
                <Text className="text-gray-500">暂无数据</Text>
              ) : (
                Object.entries(featureImportance)
                  .slice(0, 10)
                  .map(([feature, importance], index) => (
                    <View key={index} className="mb-2">
                      <View className="flex-row justify-between mb-1">
                        <Text className="text-sm text-gray-700">{feature}</Text>
                        <Text className="text-sm font-semibold text-gray-900">
                          {(importance * 100).toFixed(1)}%
                        </Text>
                      </View>
                      <View className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <View
                          className="h-full bg-blue-500"
                          style={{ width: `${Math.min(Math.max(importance * 100, 0), 100)}%` }}
                        />
                      </View>
                    </View>
                  ))
              )}
            </View>
          </ScrollView>
        )}
      </View>
  );
}

export default function MLOptimizationScreen() {
  return (
    <Screen>
      <MLOptimizationContent />
    </Screen>
  );
}
