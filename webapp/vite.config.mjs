// webapp/vite.config.mjs - 皮皮虾 Web UI 构建配置 (v5.0 重铸)
// 产物 webapp/dist 由 src/channels/http-static.js 直接静态服务:
//   - 构建产物全部是外链资源, 兼容 CSP script-src 'self' (无内联可执行脚本);
//   - 服务端 renderIndex() 会向 dist/index.html 的 </head> 前注入 ppx-boot JSON 节点;
//   - dev 模式 (npm run web:dev) 把 API 代理到本机内核 127.0.0.1:8899。
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const kernel = process.env.PPX_DEV_KERNEL || "http://127.0.0.1:8899";

const proxyTargets = ["/api", "/sessions", "/message", "/events", "/mcp", "/health", "/uploads", "/desktop"];
const proxy = Object.fromEntries(proxyTargets.map((p) => [p, { target: kernel, changeOrigin: true }]));

// 2026-11-14 (优化循环): 主包按库分块 —— 此前 817kB 单入口把 Vue 运行时 + markdown 渲染栈
//   (markdown-it/dompurify/katex/highlight.js) 全塞进根 chunk, 解析全在首屏单线程里。
//   分块后浏览器并行加载、按块缓存, 预算由 scripts/check-web.mjs 的 chunk-budget 检查守门。
// 坑 (实测): 本仓 Vite 7 打包内核对顶层 build.manualChunks **静默无视** (函数整轮不调用,
//   连强制同名实验都不改变产物); 必须放 rollupOptions.output.manualChunks —— 告警文本
//   自己指的就是这条路。
function manualChunks(id) {
  if (!id.includes("node_modules")) return undefined;
  if (/[\\/]node_modules[\\/](vue|@vue)[\\/]/.test(id)) return "vendor-vue";
  // 渲染栈: markdown-it 及其传递依赖 (linkify-it/mdurl/entities) + 消毒/公式/高亮
  if (/[\\/]node_modules[\\/](markdown-it|linkify-it|mdurl|entities|dompurify|katex|highlight\.js)[\\/]/.test(id)) {
    return "vendor-render";
  }
  return "vendor";
}

export default defineConfig({
  root,
  plugins: [vue()],
  publicDir: path.join(root, "public"),
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: { output: { manualChunks } },
  },
  server: {
    port: Number(process.env.PPX_DEV_PORT || 5173),
    strictPort: false,
    proxy,
  },
});
