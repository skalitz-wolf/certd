# 如何构建 certd 镜像

本文档记录从源码构建 certd 镜像并推送到公司 Harbor 的完整命令。

镜像构建使用 `packages/ui/Dockerfile`，构建上下文是 `packages/ui/`。

## 一、前置准备

### 1.1 工具

- `podman`（本机版本 5.8.2，WSL2 环境）
- `pnpm`（仅本地构建前端时需要；镜像内固定用 10.33.4）

### 1.2 登录 Harbor

推送前必须先登录，凭据会写入 `~/.config/containers/auth.json`：

```bash
podman login harbor.jxlife.com.cn
```

### 1.3 确认 vendor 目录完整

构建依赖 `packages/ui/vendor/` 下的预置文件，**缺少任何一个都会导致构建失败**：

```bash
ls -lh packages/ui/vendor/
```

应当包含：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `pnpm-lock.yaml` | ~240 KB | 锁定全部依赖版本，避免构建时做版本解析 |
| `package.json` | ~7 KB | 已把 `@certd/*` 固定到 `CERTD_DEP_VERSION` |
| `lego_v4.30.1_linux_amd64.tar.gz` | ~19 MB | lego 二进制包 |
| `jks-go_linux_amd64` | ~3.1 MB | jks-go 二进制 |
| `better-sqlite3-v11.10.0-node-v127-linuxmusl-x64.tar.gz` | ~1.2 MB | better-sqlite3 预编译产物 |

> 这些文件预置在仓库里，是为了让构建过程不依赖 GitHub / npmmirror 的连通性。
> 详见文末「为什么依赖要预置在 vendor」。

## 二、构建前端

镜像构建会把 `certd-client/dist/` 复制到服务端，因此**必须先编译前端**。

```bash
cd packages/ui/certd-client
pnpm install
pnpm build
```

产物输出到 `packages/ui/certd-client/dist/`。

> 如果 `dist/` 里已有可用的构建产物且前端代码没改动，可以跳过这一步。

## 三、构建镜像

```bash
cd packages/ui

podman build --platform linux/amd64 \
  -t harbor.jxlife.com.cn/public/certd:v1.42.6.2 \
  -f Dockerfile .
```

### 3.1 参数说明

| 参数 | 说明 |
| --- | --- |
| `--platform linux/amd64` | 目标平台。生产环境是 x86_64，本机是 arm 或 WSL2 时也必须显式指定 |
| `-t <仓库>:<标签>` | 镜像名。注意 `public` 是 Harbor 的 project 22 |
| `-f Dockerfile` | 相对 `packages/ui/` 的 Dockerfile 路径 |
| `.` | 构建上下文。**必须是 `packages/ui/`，不能是仓库根目录** |

### 3.2 可覆盖的构建参数

| ARG | 默认值 | 说明 |
| --- | --- | --- |
| `CERTD_DEP_VERSION` | `1.42.6` | `@certd/*` 依赖的版本，升级上游时同步修改 |
| `base_type` | `alpine` | 可选 `alpine` / `slim`（slim 走 `node:22-trixie-slim`） |

用法：

```bash
podman build --platform linux/amd64 \
  --build-arg CERTD_DEP_VERSION=1.42.6 \
  -t harbor.jxlife.com.cn/public/certd:v1.42.6.2 \
  -f Dockerfile .
```

### 3.3 耗时

| 场景 | 耗时 |
| --- | --- |
| 首次构建（空缓存） | 约 5~8 分钟 |
| 二次构建（源码有改动，依赖缓存命中） | 约 3.5 分钟 |
| 完全无改动 | 秒级（全部走缓存） |

依赖层用了 `--mount=type=cache`，pnpm store 会跨构建复用。
命中缓存时依赖安装约 6 秒（首次约 4~8 分钟）。

## 四、验证镜像

构建完成后建议先验证再推送：

```bash
# 查看镜像大小
podman images harbor.jxlife.com.cn/public/certd

# 验证关键产物
podman run --rm --platform linux/amd64 harbor.jxlife.com.cn/public/certd:v1.42.6.2 sh -c "
  node -v
  node -e \"require('better-sqlite3'); console.log('better-sqlite3 OK')\"
  ls /app/tools/lego /app/tools/jks-go
  ls /app/dist/controller/sys/ | grep -E 'dbtool|redistool'
"
```

正常输出应包含 `better-sqlite3 OK`、`lego_v4.30.1_linux_amd64.tar.gz`、`jks-go_linux_amd64`、`dbtool`、`redistool`。

启动冒烟测试：

```bash
podman run --rm --platform linux/amd64 -d --name certd-smoke \
  harbor.jxlife.com.cn/public/certd:v1.42.6.2

sleep 40
podman logs certd-smoke | tail -20
podman rm -f certd-smoke
```

日志里应出现 `Certd已启动`、`当前版本:1.42.6`、`Https server is listening on https://:::7002`。

## 五、推送镜像

```bash
podman push harbor.jxlife.com.cn/public/certd:v1.42.6.2
```

确认远端已存在该标签：

```bash
podman search --list-tags harbor.jxlife.com.cn/public/certd
```

## 六、完整命令速查

```bash
# 1. 登录
podman login harbor.jxlife.com.cn

# 2. 编译前端
cd packages/ui/certd-client && pnpm install && pnpm build

# 3. 构建镜像
cd packages/ui && podman build --platform linux/amd64 \
  -t harbor.jxlife.com.cn/public/certd:v1.42.6.2 -f Dockerfile .

# 4. 推送
podman push harbor.jxlife.com.cn/public/certd:v1.42.6.2

# 5. 确认
podman search --list-tags harbor.jxlife.com.cn/public/certd
```

## 七、升级维护

### 7.1 升级上游版本

1. 修改 `packages/ui/Dockerfile` 里的 `ARG CERTD_DEP_VERSION`
2. 重新生成 `packages/ui/vendor/pnpm-lock.yaml` 和 `package.json`：

```bash
mkdir -p .lockgen
cp packages/ui/certd-server/package.json packages/ui/certd-server/.npmrc .lockgen/
sed -i '/better[-_]sqlite3_binary_host/d' .lockgen/.npmrc

# 把 @certd/* 固定到新版本
node -e "
const fs=require('fs');
const f='.lockgen/package.json';
const p=JSON.parse(fs.readFileSync(f,'utf8'));
for (const k of ['dependencies','devDependencies']) {
  for (const n of Object.keys(p[k]||{})) {
    if (n.startsWith('@certd/') && p[k][n].startsWith('^1.')) p[k][n]='<新版本>';
  }
}
fs.writeFileSync(f, JSON.stringify(p,null,2));
"

# 在容器内装一次，生成 lockfile
podman run --rm --platform linux/amd64 \
  -v "$PWD/.lockgen:/deps:Z" node:22-alpine sh -c "
    npm install -g pnpm@10.33.4 --registry=https://registry.npmmirror.com
    cd /deps && pnpm install --ignore-scripts
  "

cp .lockgen/pnpm-lock.yaml .lockgen/package.json packages/ui/vendor/
rm -rf .lockgen
```

3. 如果依赖里 `better-sqlite3` 版本变了，同步替换 vendor 里的预编译产物（文件名里的版本号和 ABI 需对应）：

```bash
# ABI：node 22 为 v127
curl -sSL -o packages/ui/vendor/better-sqlite3-v<版本>-node-v127-linuxmusl-x64.tar.gz \
  "https://registry.npmmirror.com/-/binary/better-sqlite3/v<版本>/better-sqlite3-v<版本>-node-v127-linuxmusl-x64.tar.gz"
```

并同步修改 Dockerfile 里 `--mount=type=bind,source=vendor/better-sqlite3-...` 的文件名。

### 7.2 升级 lego / jks-go

1. 替换 `packages/ui/vendor/` 下的文件
2. 修改 Dockerfile 里的 `ENV LEGO_VERSION` / `ENV JKS_GO_VERSION`（`COPY` 路径里引用了这两个变量）

## 八、为什么依赖要预置在 vendor

以下每一条都对应一次真实踩坑，改动前请确认理解：

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| `ERR_PNPM_NO_MATCHING_VERSION @certd/plus-core@^1.45.5` | 构建上下文只有 `packages/ui/`，容器内没有 workspace 的 `@certd/*` 包，会从 npm 解析到最新版；而最新版 `lib-server@1.45.5` 依赖尚未发布的 `plus-core@^1.45.5` | vendor 里的 `package.json` 固定版本 |
| `apk add` 超时 / `TLS: unspecified error` | 基础镜像的源指向 `dl-cdn.alpinelinux.org`，容器内不通 | 换成 `http://mirrors.huaweicloud.com`（注意是 http） |
| `better-sqlite3` 报 `gyp ERR! find Python` | `.npmrc` 把预编译下载地址指向 npmmirror，该地址在容器内 TLS 会被重置；失败后回退 node-gyp 编译，而 alpine 无 python/g++ | vendor 预置预编译产物 + `--ignore-scripts` 手工解压 |
| `prebuild-install warn install Request timed out` | 去掉 npmmirror 地址后走 GitHub，网络不稳定，19MB 文件经常超时 | 同上，彻底不下载 |
| lego / jks-go 下载极慢 | 容器内直连 GitHub release 很慢（19MB 文件 90 秒才 13%） | vendor 预置二进制 |
| `@types/jest` ETIMEDOUT | 网络抖动，918 个包下载到 892 个时失败 | `--fetch-retries=8` + 缓存挂载 |
| runtime 阶段 `npm install -g pnpm` 超时 | 该阶段没有 `.npmrc`，走默认 npm 源 | 显式加 `--registry` |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | `pnpm prune` 在无 TTY 环境下需要确认 | 加 `CI=true` |
| `pnpm prune --prod` 报 `gyp ERR! find Python`，且 better-sqlite3 产物丢失 | prune 会**重建整个 node_modules**，重新执行 install 脚本触发 node-gyp；同时手工解压的预编译产物被删掉 | prune 加 `--ignore-scripts --config.store-dir=/pnpm-store`，并在 prune 后重新解压预编译产物（注意 prune 不认 `--store-dir`，要用 `--config.store-dir=`） |
| 改了 `packages/libs/**` 但镜像行为没变 | 构建上下文只有 `packages/ui/`，`@certd/*` 从 npm 解析，本地 libs 源码不进镜像 | 服务端改动放 `packages/ui/certd-server/**`，或在 Dockerfile 里显式覆盖 |

### 关于 pnpm 版本

镜像内固定 `pnpm@10.33.4`。pnpm v11 会报 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts`，
因此 `vendor/pnpm-lock.yaml` 必须用 10.x 生成（当前是 `lockfileVersion: '9.0'`）。
本机 pnpm 若是 12.x，请按 7.1 的方式在容器里生成。

### 关于 optional 依赖的编译错误

构建日志里会出现 `cpu-features` / `ssh2` 的 `Unable to detect compiler type` 报错。
这些是 optional 依赖的 native 编译，在 alpine 下必然失败，pnpm 会自动跳过，**不影响构建**。

## 九、运行时开关

`dbtool` / `redistool` 两个中转接口**默认关闭**，镜像里没有设置对应环境变量，接口返回 404。

需要时在部署阶段显式开启：

```bash
podman run -d \
  -e CERTD_DBTOOL_ENABLED=true \
  -e CERTD_REDISTOOL_ENABLED=true \
  -p 7001:7001 -p 7002:7002 \
  harbor.jxlife.com.cn/public/certd:v1.42.6.2
```
