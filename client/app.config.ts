import { ExpoConfig, ConfigContext } from 'expo/config';

const appName = process.env.COZE_PROJECT_NAME || process.env.EXPO_PUBLIC_COZE_PROJECT_NAME || '应用';
const projectId = process.env.COZE_PROJECT_ID || process.env.EXPO_PUBLIC_COZE_PROJECT_ID;
const slugAppName = projectId ? `app${projectId}` : 'myapp';

export default ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    "name": appName,
    "slug": slugAppName,
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/images/icon.png",
    "scheme": "myapp",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "ios": {
      "supportsTablet": true,
      // 允许HTTP明文流量（开发环境需要）
      "infoPlist": {
        "NSAppTransportSecurity": {
          "NSAllowsArbitraryLoads": true
        }
      }
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#ffffff"
      },
      "package": `com.anonymous.x${projectId || '0'}`
    },
    "web": {
      "bundler": "metro",
      "output": "single",
      "favicon": "./assets/images/favicon.png"
    },
    "plugins": [
      process.env.EXPO_PUBLIC_BACKEND_BASE_URL ? [
        "expo-router",
        {
          "origin": process.env.EXPO_PUBLIC_BACKEND_BASE_URL
        }
      ] : 'expo-router',
      [
        "expo-splash-screen",
        {
          "image": "./assets/images/splash-icon.png",
          "imageWidth": 200,
          "resizeMode": "contain",
          "backgroundColor": "#ffffff"
        }
      ],
      [
        "expo-image-picker",
        {
          "photosPermission": `允许Brooks雷达App访问您的相册，以便您上传或保存图片。`,
          "cameraPermission": `允许Brooks雷达App使用您的相机，以便您直接拍摄照片上传。`,
          "microphonePermission": `允许Brooks雷达App访问您的麦克风，以便您拍摄带有声音的视频。`
        }
      ]
    ],
    "experiments": {
      "typedRoutes": true
    },
    "extra": {
      "backendBaseURL": process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 
        process.env.COZE_PROJECT_DOMAIN_DEFAULT || 
        (projectId ? `https://app${projectId}.dev.coze.site` : '') ||
        'https://dfb897ac-1152-4896-90bc-d8ee26de5450.dev.coze.site'
    }
  }
}
