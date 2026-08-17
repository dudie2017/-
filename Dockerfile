FROM node:20-slim

WORKDIR /app

# 复制 server 的 package 文件（利用层缓存）
COPY server/package*.json ./

# 安装依赖（Docker 构建无 Railway 缓存挂载，不会 EBUSY）
RUN npm ci --no-audit --no-fund

# 复制 server 源码与数据
COPY server/ .

# 构建（esbuild 打包）
RUN npm run build

# 暴露端口
EXPOSE 5000

# 启动
CMD ["node", "dist/index.js"]
