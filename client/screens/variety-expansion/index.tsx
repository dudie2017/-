import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';


// 兼容 Web 和移动端的 alert
const showAlert = (title: string, message?: string) => {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}: ${message}` : title);
  } else {
    Alert.alert(title, message);
  }
};

const showAlertWithConfirm = (
  title: string,
  message: string,
  onConfirm: () => void
) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}: ${message}`)) {
      onConfirm();
    }
  } else {
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      { text: '确定', onPress: onConfirm },
    ]);
  }
};

interface VarietyStatus {
  code: string;
  name: string;
  sector: string;
  hasBacktest: boolean;
  hasModel: boolean;
  modelAccuracy?: number;
  modelVersion?: string;
  barsCount?: number;
}

export default function VarietyExpansionScreen() {
  const router = useSafeRouter();
  const [varieties, setVarieties] = useState<VarietyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [batchTraining, setBatchTraining] = useState(false);

  const loadVarieties = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/variety-expansion/status`
      );
      const result = await response.json();
      if (result.success) {
        setVarieties(result.data.varieties || []);
      }
    } catch (error) {
      console.error('Failed to load varieties:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadVarieties();
    }, [loadVarieties])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    loadVarieties();
  };

  const handleTrainModel = async (code: string) => {
    try {
      /**
       * 服务端文件：server/src/routes/varietyExpansion.ts
       * 接口：POST /api/v1/variety-expansion/train-model/:code
       * Path 参数：code: string（品种代码，如 MA0）
       */
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/variety-expansion/train-model/${code}`,
        { method: 'POST' }
      );
      const result = await response.json();
      if (result.success) {
        showAlert('成功', `${code} 模型训练成功`);
        loadVarieties();
      } else {
        showAlert('训练失败', result.error);
      }
    } catch (error) {
      showAlert('训练失败', String(error));
    }
  };

  const runBatchTrain = async () => {
    setBatchTraining(true);
    try {
      /**
       * 服务端文件：server/src/routes/varietyExpansion.ts
       * 接口：POST /api/v1/variety-expansion/batch-train
       * 无请求参数
       */
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/variety-expansion/batch-train`,
        { method: 'POST' }
      );
      const result = await response.json();
      if (result.success) {
        showAlert('完成', `批量训练完成：${result.data.successCount} 个品种成功`);
        loadVarieties();
      } else {
        showAlert('批量训练失败', result.error);
      }
    } catch (error) {
      showAlert('批量训练失败', String(error));
    } finally {
      setBatchTraining(false);
    }
  };

  const handleBatchTrain = () => {
    showAlertWithConfirm('批量训练', '确定要批量训练所有品种的模型吗？', runBatchTrain);
  };

  const renderVarietyItem = ({ item }: { item: VarietyStatus }) => (
    <View className="bg-white dark:bg-gray-800 rounded-xl p-4 mb-3 shadow-sm">
      <View className="flex-row justify-between items-start mb-2">
        <View className="flex-1">
          <Text className="text-lg font-bold text-gray-900 dark:text-white">
            {item.code}
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400">
            {item.name} · {item.sector}
          </Text>
        </View>
        <View className="flex-row gap-2">
          {item.hasBacktest && (
            <View className="bg-green-100 dark:bg-green-900 px-2 py-1 rounded">
              <Text className="text-xs text-green-700 dark:text-green-300">
                回测 ✓
              </Text>
            </View>
          )}
          {item.hasModel && (
            <View className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded">
              <Text className="text-xs text-blue-700 dark:text-blue-300">
                模型 ✓
              </Text>
            </View>
          )}
        </View>
      </View>

      {item.hasModel && (
        <View className="mb-2">
          <Text className="text-sm text-gray-600 dark:text-gray-400">
            准确率：{((item.modelAccuracy ?? 0) * 100).toFixed(1)}% · 版本：{item.modelVersion}
          </Text>
        </View>
      )}

      {item.hasBacktest && !item.hasModel && (
        <TouchableOpacity
          className="bg-indigo-500 px-4 py-2 rounded-lg mt-2"
          onPress={() => handleTrainModel(item.code)}
        >
          <Text className="text-white text-sm font-medium">训练模型</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  if (loading) {
    return (
      <Screen>
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#6366f1" />
          <Text className="text-gray-600 dark:text-gray-400 mt-4">加载中...</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View className="flex-1 bg-gray-50 dark:bg-gray-900 p-4">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-2xl font-bold text-gray-900 dark:text-white">
            品种扩展管理
          </Text>
          <TouchableOpacity
            className={`bg-indigo-500 px-4 py-2 rounded-lg ${
              batchTraining ? 'opacity-50' : ''
            }`}
            onPress={handleBatchTrain}
            disabled={batchTraining}
          >
            <Text className="text-white text-sm font-medium">
              {batchTraining ? '训练中...' : '批量训练'}
            </Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={varieties}
          renderItem={renderVarietyItem}
          keyExtractor={(item) => item.code}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          ListEmptyComponent={
            <View className="py-12 items-center">
              <Text className="text-gray-500 dark:text-gray-400">
                暂无品种数据
              </Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}
