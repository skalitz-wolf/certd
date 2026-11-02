# Handoff：certd 构建依赖梳理 → Dockerfile 离线化改造

## 背景

上一轮会话完成了对 certd 仓库（`D:\Users\Administrator\Projects\certd`，分支 HEAD 检出于 v2 线）"从编译到构建镜像"的依赖梳理，结论如下（详见仓库文件，勿重复分析）：

### 构建链路事实（已确认）

- **monorepo**：pnpm（**锁定 10.33.4**，v11 会报 `ERR_PNPM_IGNORED_BUILDS`）+ lerna-lite；仓库**没有 pnpm-lock.yaml**。
- **编译**：前端 `packages/ui/certd-client`（Vite）→ 后端 `packages/ui/certd-server` 的 `build-on-docker`（mwtsc + 导出插件 metadata），前端 dist 拷入 `certd-server/public/`；核心包 `packages/core/*`、`packages/plugins/*` 先各自 tsc。
- **原生模块**：better-sqlite3、ssh2、aws-crt、cos-js-sdk-v5 等需要编译或有预编译二进制；`.npmrc` 将 better-sqlite3 二进制指向 npmmirror。
- **镜像**：[packages/ui/Dockerfile](../packages/ui/Dockerfile) 多架构（amd64/arm64/armv7）× `base_type=alpine|slim`，基础镜像 `node:22-alpine` / `node:22-trixie-slim`；构建时从 GitHub Releases 下载 **lego v4.30.1** 和 **jks-go v1.0.3**；`apk add build-base`（builder）/ openssl、netcat-openbsd、dnsutils、iproute2 等（slim 运行时）；`COPY ./patch/ssh2/*.js`（位于 `packages/ui/patch/`）覆盖 ssh2 模块。
- **独立基础镜像**：[scripts/build/Dockerfile](../scripts/build/Dockerfile) 编译 jemalloc 5.3.0，产出 `greper/node-base:22-alpine-1`。
- **发布目标**：`registry.cn-shenzhen.aliyuncs.com/handsfree/certd`、`ghcr.io/certd/certd`、`greper/certd`。
- **运行时**：默认 SQLite（`/app/data` 数据卷），可选 PG/MySQL/MariaDB（flyway 迁移）；插件云厂商 SDK **运行时**动态安装到 `./data/.runtime-deps`，registry 在 npmmirror/npmjs 间自动探测，配置见 `packages/ui/certd-server/src/config/config.default.ts:109`（`runtimeDeps`，含 `autoInstall`、`registry.fixedUrl`）。
- **源码部署**：`start.sh` 下载 `atomgit.com/certd/certd/releases/download/v<版本>/ui-<版本>.zip`。
- 仓库规则见根目录 `AGENTS.md`（中文注释、pnpm 专用、不要主动 `pnpm install` 等）。

## 下一任务（用户已同意的方向）

**把 packages/ui/Dockerfile 改成支持"预下载文件目录"的形式：本地存在预下载文件就 COPY，不存在才回退 wget。** 用户要求**生成文件存放在本项目内**（本文件即存于项目根）。

### 建议的实现要点

1. Dockerfile 顶部 `ARG` + 可选的构建上下文目录（如 `prebuilt/`），用 `COPY prebuilt*/ prebuilt/` + `test -f` 判断回退逻辑，或分阶段 `ONBUILD`；注意 `COPY` 一个不存在的目录会直接构建失败，需要用空目录占位或 `prebuilt*` 通配技巧。
2. 覆盖对象：lego v4.30.1（amd64/arm64 tar.gz）、jks-go v1.0.3（amd64/arm64/armv7）、jemalloc-5.3.0.tar.bz2（如需改 scripts/build/Dockerfile）、pnpm 安装与 apk/apt 包可选内网化。
3. 运行时 SDK 离线化：文档化"预装 `data/.runtime-deps` + `certd_runtimeDeps_autoInstall=false` 或 `registry.fixedUrl` 指向内网 npm"两个方案（不必改代码）。
4. 保持 `pnpm@10.33.4` 固定版本不变；中文注释，沿用现有 Dockerfile 风格。

## 建议技能（Suggested skills）

- `anthropic-skills:code-review`：改完 Dockerfile 后自查。
- `anthropic-skills:frontend-design` / 其他：不需要。无前端改动。
- 无需 `run`：Docker 构建需用户环境验证，不应自动跑。

## 环境注意

- Windows 11 + Git Bash；PowerShell 读中文文件需 `Get-Content -Raw -Encoding UTF8`。
- 本文件按用户要求存放在项目根（偏离了 skill 默认的 %TEMP% 位置）；是否随仓库提交由用户决定，默认不要 `git add`。
