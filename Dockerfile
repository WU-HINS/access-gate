# access-gate · 生产镜像（多阶段，M6-7）
#
# ★ 三条与生产相关的取舍：
#   1. **多阶段构建**：devDependencies（typescript/@types）不进运行时镜像。
#   2. **非 root 运行**：容器逃逸的第一步通常是「进程以 root 跑」。
#   3. **只拷贝必要文件**：源码 + node_modules（prod）+ docs（供 /healthz 报迁移期望版本）。
#      不拷贝 tests/tools 之外的开发脚本——但保留 tools/db-migrate.ts，因为启动时要跑迁移。

FROM node:22-alpine AS build
WORKDIR /app
# 单独拷贝清单以利用层缓存（改源码不会让依赖重装）
# ★ 必须连 `package-lock.json` 一起拷，并用 `npm ci`：
#   `npm install` 会**重新解析**传递依赖，同一个 package.json 在不同时间
#   可能装到不同版本——生产镜像的基本要求是**可复现构建**。
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY tools ./tools
COPY test ./test
# 类型检查作为构建门禁：类型不过的镜像不允许产出
RUN npx tsc -p tsconfig.json --noEmit

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    AG_HOST=0.0.0.0 \
    AG_PORT=8787
RUN apk add --no-cache tini \
 && addgroup -S app -g 10001 \
 && adduser -S app -u 10001 -G app \
 && mkdir -p /app/runtime && chown -R app:app /app

# ★ 同样带 lock 文件并走 `npm ci`（可复现）；`--omit=dev` 让 devDependencies 不进运行时
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# 直接以 .ts 运行：Node 22 的类型剥离让我们不需要额外构建步骤（也避免产物与源码漂移）
COPY --chown=app:app src ./src
COPY --chown=app:app web ./web
COPY --chown=app:app tools ./tools
COPY --chown=app:app docs ./docs
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app sql ./sql

USER app
EXPOSE 8787

# tini 作为 PID 1：正确处理 SIGTERM（否则优雅关闭收不到信号，会被强杀）
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "tools/serve.ts", "--demo=false"]
