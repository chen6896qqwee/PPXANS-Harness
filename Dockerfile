# PPXANS-Harness 容器一键启动
# 纯 Node 零运行时依赖 → 镜像就是官方 node 基础层 + 源码, 无编译步骤。
# 用法:
#   docker build -t ppxans-harness .
#   docker run -p 8899:8899 -v ppxans-data:/data ppxans-harness
#   # 指定模型: -e PPX_MODEL=<模型名> -e <API_KEY 环境变量名>=<key>
#     (密钥经 config.ppj.json 引用环境变量, 见 docs/CONFIG.md; 不建议把密钥烧进镜像)
FROM node:22-alpine

LABEL org.opencontainers.image.title="PPXANS-Harness"
LABEL org.opencontainers.image.description="皮皮虾神经系 (ANS) + Harness 一体化智能体内核. 纯 Node 零运行时依赖."
LABEL org.opencontainers.image.source="https://github.com/chen6896qqwee/PPXANS-Harness"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    PPX_PORT=8899 \
    PPX_HOST=0.0.0.0 \
    PPX_NO_OPEN=1 \
    PPX_DATA_DIR=/data

# alpine 自带 musl +BusyBox:皮皮虾 run_command 工具依赖的基础 shell 就绪;
# 不装任何额外包, 保持镜像最小 (零依赖叙事在容器侧同样成立)。
WORKDIR /app

# 依赖清单先拷 (若未来出现可选依赖, 利用层缓存)
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY config ./config
COPY public ./public
COPY skills ./skills

# 运行时数据 (会话/记忆/审计账本) 落卷: 容器可丢, 记忆不可丢
VOLUME ["/data"]

# 非 root: 工具层有 run_command, 容器内再提权只会放大风险面
RUN addgroup -S ppx && adduser -S ppx -G ppx \
    && mkdir -p /data && chown -R ppx:ppx /data /app
USER ppx

EXPOSE 8899

# 健康探测走 /health (与 channels/http 同源端点语义)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PPX_PORT||8899)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/ppx-web.js"]
