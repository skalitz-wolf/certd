ARG base_type=alpine

# 根据 base_type 参数选择基础镜像系列
FROM --platform=linux/amd64 node:22-alpine AS base-amd64-alpine
FROM --platform=linux/arm64 node:22-alpine AS base-arm64-alpine
FROM --platform=linux/arm/v7 node:22-alpine AS base-arm-v7-alpine

FROM --platform=linux/amd64 node:22-trixie-slim AS base-amd64-slim
FROM --platform=linux/arm64 node:22-trixie-slim AS base-arm64-slim
FROM --platform=linux/arm/v7 node:22-alpine AS base-arm-v7-slim

FROM base-${TARGETARCH}${TARGETVARIANT:+-}${TARGETVARIANT}-${base_type} AS builder

WORKDIR /workspace/
# pnpm v11打包会报错（[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts），暂时固定10.33.4版本。
# https://pnpm.io/zh/migration
RUN npm install -g pnpm@10.33.4 --registry=https://registry.npmmirror.com

ARG CERTD_DEP_VERSION=1.42.6
ARG PNPM_STORE=/pnpm-store

# ---- 依赖层：只依赖 package.json，源码改动不会让它失效 ----
# 构建上下文只有 packages/ui/，容器内没有 workspace 里的 @certd/* 包，
# 依赖会从 npm 解析。上游最新版存在 peer 依赖缺失（lib-server@1.45.5 要求
# plus-core@^1.45.5，但该版本未发布），因此把 @certd/* 固定到已知可用版本。
# 升级依赖时同步调整 CERTD_DEP_VERSION。
# .npmrc 里把 better-sqlite3 的预编译下载地址指向了 npmmirror，
# 该地址在容器内 TLS 会被重置，导致回退到 node-gyp 现场编译（alpine 无 python/g++）。
# 去掉这些配置，让 prebuild-install 使用默认的 GitHub release 地址。
COPY vendor/package.json /deps/package.json
COPY certd-server/.npmrc /deps/.npmrc
COPY vendor/pnpm-lock.yaml /deps/pnpm-lock.yaml

# alpine 无 python/g++，better-sqlite3 必须用预编译产物。
# 从 github 现下不稳定（超时后回退 node-gyp 必然失败），因此预置于 vendor 并手工解压。
# vendor/pnpm-lock.yaml 锁定了全部版本，安装时无需再做版本解析（否则每个包要拉一次元数据）。
RUN --mount=type=cache,target=/pnpm-store,id=certd-pnpm-store \
    --mount=type=bind,source=vendor/better-sqlite3-v11.10.0-node-v127-linuxmusl-x64.tar.gz,target=/tmp/bs.tar.gz \
    cd /deps && \
    sed -i -e '/better[-_]sqlite3_binary_host/d' .npmrc && \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir=$PNPM_STORE --fetch-retries=8 --fetch-timeout=180000 --fetch-retry-maxtimeout=240000 && \
    BS=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 | head -1) && \
    tar -xzf /tmp/bs.tar.gz -C "$BS" && \
    ls -l "$BS/build/Release/better_sqlite3.node"

# ---- 源码层 ----
COPY . /workspace/
RUN cp /deps/package.json /workspace/certd-server/package.json && \
    cp /deps/pnpm-lock.yaml /workspace/certd-server/pnpm-lock.yaml && \
    cp -a /deps/node_modules /workspace/certd-server/node_modules && \
    cd /workspace/certd-server && \
    cp /workspace/certd-client/dist/* ./public/ -rf && \
    npm run build-on-docker

# 裁掉 devDependencies，运行时阶段直接复用，省去第二次完整安装。
# pnpm prune 会重建 node_modules，因此：
#   1. 必须 --ignore-scripts，否则 better-sqlite3 / cpu-features 会触发 node-gyp，
#      alpine 无 python/g++ 必然失败；
#   2. 复用同一个 pnpm store 缓存，避免重新下载全部依赖；
#   3. prune 会丢掉手工解压的预编译产物，需重新解压 better-sqlite3。
RUN --mount=type=cache,target=/pnpm-store,id=certd-pnpm-store \
    --mount=type=bind,source=vendor/better-sqlite3-v11.10.0-node-v127-linuxmusl-x64.tar.gz,target=/tmp/bs.tar.gz \
    cd /workspace/certd-server && \
    CI=true pnpm prune --prod --ignore-scripts --config.store-dir=/pnpm-store && \
    BS=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 | head -1) && \
    tar -xzf /tmp/bs.tar.gz -C "$BS" && \
    ls -l "$BS/build/Release/better_sqlite3.node"

ARG base_type=alpine

# ------------------------------------------------------------------
# 构建生产环境镜像
# ------------------------------------------------------------------
FROM base-${TARGETARCH}${TARGETVARIANT:+-}${TARGETVARIANT}-${base_type}
EXPOSE 7001
EXPOSE 7002

ARG base_type=alpine

# 记录构建来源的提交，便于反查线上镜像是哪份代码构建的。
# 构建时传入：--build-arg GIT_REVISION=$(git rev-parse HEAD)
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION

# 根据基础镜像发行版选择包管理器
# trixie-slim -> apt-get, alpine -> apk
RUN if [ -f /etc/alpine-release ]; then \
        sed -i -e 's|https\?://dl-cdn.alpinelinux.org|http://mirrors.huaweicloud.com|g' -e 's|https\?://mirror.clarks.com|http://mirrors.huaweicloud.com|g' /etc/apk/repositories; \
    fi; \
    if [ -f /etc/debian_version ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends \
            ca-certificates \
            wget \
            openssl \
            netcat-openbsd \
            iputils-ping \
            dnsutils \
            iproute2 \
        && apt-get clean \
        && rm -rf /var/lib/apt/lists/*; \
    elif [ -f /etc/alpine-release ]; then \
        apk add --no-cache openssl wget ca-certificates; \
    else \
        echo "Unsupported base image"; exit 1; \
    fi

WORKDIR /app/

ENV TERM=xterm
ENV LEGO_VERSION=4.30.1
ENV LEGO_DOWNLOAD_DIR=/app/tools/lego

ENV JKS_GO_VERSION=1.0.3
ENV JKS_GO_DOWNLOAD_DIR=/app/tools/jks-go

ENV ALIYUN_CLIENT_CONNECT_TIMEOUT=10000
ENV ALIYUN_CLIENT_READ_TIMEOUT=20000

RUN mkdir -p $LEGO_DOWNLOAD_DIR

# lego / jks-go 预置于 packages/ui/vendor，避免每次构建从 github 下载
# 更新版本时替换 vendor 下的文件并同步版本号
COPY ./vendor/lego_v${LEGO_VERSION}_linux_amd64.tar.gz $LEGO_DOWNLOAD_DIR/
RUN printf 'https://github.com/go-acme/lego/releases/download/v%s\n' "$LEGO_VERSION" > $LEGO_DOWNLOAD_DIR/readme.md

RUN mkdir -p $JKS_GO_DOWNLOAD_DIR

COPY ./vendor/jks-go_linux_amd64 $JKS_GO_DOWNLOAD_DIR/jks-go_linux_amd64
RUN chmod +x $JKS_GO_DOWNLOAD_DIR/jks-go_linux_amd64 && \
    ln -s $JKS_GO_DOWNLOAD_DIR/jks-go_linux_amd64 /usr/local/bin/jks-go

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV MIDWAY_SERVER_ENV=production

RUN npm install -g pnpm@10.33.4 --registry=https://registry.npmmirror.com


COPY --from=builder /workspace/certd-server/ /app/
COPY ./patch/ssh2/*.js /app/node_modules/.pnpm/node_modules/ssh2/lib/protocol/
# plus-core 本地试用验签补丁，详见 patch/plus-core/README.md
# 校验逻辑：必须恰好命中一个 plus-core 安装目录，且覆盖后文件里确实含有 local-trial 放行代码，
# 否则构建失败（避免补丁静默丢失导致本地试用不可用）。
COPY ./patch/plus-core/index.js /app/patch/plus-core/index.js
RUN set -e; \
    targets=$(ls -d /app/node_modules/.pnpm/@certd+plus-core@*/node_modules/@certd/plus-core/dist/index.js 2>/dev/null || true); \
    count=$(echo "$targets" | grep -c . || true); \
    if [ "$count" != "1" ]; then \
        echo "ERROR: 期望找到 1 个 plus-core dist/index.js，实际找到 $count 个："; echo "$targets"; exit 1; \
    fi; \
    cp /app/patch/plus-core/index.js "$targets"; \
    grep -q 'local-trial' "$targets" || { echo "ERROR: plus-core 补丁未生效"; exit 1; }; \
    echo "plus-core 补丁已应用: $targets"
CMD ["node", "--optimize-for-size", "./bootstrap.js"]
