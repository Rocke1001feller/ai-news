import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // 相对路径基准:同一份构建产物可在任意深度工作——gh-pages 项目页(/ai-news/)、
  // xiaocha.online/ai-news/ 子路径反代、ai-news.poorhub.store 根路径子域名。
  // 前提:无 history 路由(纯状态切换);资源与 data/ 数据均经 import.meta.env.BASE_URL
  // 拼接(('./')前缀),随页面所在 URL 解析。若未来引入客户端路由深链需重新评估。
  base: './',
  server: {
    port: 3000,
    open: true,
    fs: {
      allow: ['..']
    }
  },
  publicDir: path.resolve(__dirname, '../'),
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    copyPublicDir: false,
  },
})
