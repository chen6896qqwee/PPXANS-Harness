import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 代理到本地 agent server (8899), 前端只认自己的域名
  // 注意: /message/stream 必须单独配, Next.js rewrites 的 source 是精确路径匹配 (不加这条 Web 聊天会 404)
  async rewrites() {
    return [
      { source: "/message", destination: "http://127.0.0.1:8899/message" },
      { source: "/message/stream", destination: "http://127.0.0.1:8899/message/stream" },
      { source: "/sessions", destination: "http://127.0.0.1:8899/sessions" },
      { source: "/sessions/:path*", destination: "http://127.0.0.1:8899/sessions/:path*" },
      { source: "/api/:path*", destination: "http://127.0.0.1:8899/api/:path*" },
    ];
  },
};

export default nextConfig;