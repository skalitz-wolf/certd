# 镜像平台收敛与 vendor 预置策略：仅 amd64/alpine、二进制入 git、构建期护栏

`packages/ui/Dockerfile` 的 vendor 化改造（二进制入库、依赖层缓存分离）容易让人误以为目标是「离线构建」。实际目标是两个：**构建提速**（消除 GitHub release 下载这个最慢、最不稳定的环节）和**最小化与上游的 diff**（便于长期 merge）。依赖 tarball 仍来自 npmmirror，apk/apt 仍走华为云镜像，不是完全离线。

基于这个定位，做如下收敛：

- **仅支持 `linux/amd64` + alpine**。生产环境是 x86_64，为不存在的 arm/slim 需求维护多份二进制不值得。两种失败模式区别对待：
  - 错架构：`COPY vendor/lego_v..._linux_amd64.tar.gz` 直接失败（响亮坏，无需额外断言）；
  - `base_type=slim`：构建能正常走完，但 vendor 的 better-sqlite3 预编译产物是 musl 版，native 模块在 glibc 下加载失败发生在**运行时**（静默坏），因此在 builder 阶段开头用 `/etc/debian_version` 断言拦下。
- **vendor 二进制纯 git 入库**（lego/jks-go/better-sqlite3，约 23MB）。不用 git-lfs（为高频升级/大规模协作设计，本仓库单人 fork、低频升级）也不用外部制品库（会重新引入「构建依赖额外源」，与提速目标矛盾）。代价是仓库历史只增不减，升级 lego 一次 +19MB，可接受。
- **构建期护栏**（全部参照 plus-core 补丁校验的风格：静默坏必须在构建期拦下）：
  1. `certd-server/package.json` 版本 = `vendor/package.json` 版本：防「merge 假生效」——merge 上游后镜像里跑的仍是 npm 旧版 `@certd/*`，测试全过但改动没进镜像（同 plus 试用排障一天的坑）；
  2. lockfile 中 better-sqlite3 版本 = vendor 预编译包文件名版本：防升依赖时忘了换 tar.gz，解压出旧版二进制，ABI 不匹配运行时才炸。
- **`CERTD_DEP_VERSION` ARG 删除**：它声明后从未生效（版本 pin 死在 vendor/package.json），留着会误导后来者以为改 ARG 就能升版本。版本唯一真相是 vendor/package.json。
- **apk 镜像源用 https**：早期用 `http://mirrors.huaweicloud.com` 排障，后改回 https，避免构建期包下载走明文。

## 考虑过的替代方案

- **保留上游多架构矩阵 + 下载回退路径**（本地有 vendor 文件就 COPY、没有就 wget）：两套路径都要维护，回退分支永远测不到，违背最小 diff 目标，弃。
- **把 FROM 行砍成单行 `FROM node:22-alpine`**：更干净，但与上游 Dockerfile 结构性分叉，以后每次 merge 上游改动都冲突；保留 6 行 FROM（含 4 个死变体）是给 merge 留余地的有意选择。
- **vendor 迁 git-lfs / 外部制品库**：见上，弃。
- **better-sqlite3 解压逻辑抽成脚本供两处 RUN 复用**：两处隔着 40 行上下文，各自完整呈现动作反而好读；且 vendor 目录应只放预置产物，弃。

## Consequences

- 需要构建 arm64/slim 时，必须先补 vendor 产物（lego/jks-go/better-sqlite3 三类）再解除对应断言，这是刻意的摩擦。
- 依赖升级需同步三处版本号（certd-server/package.json、vendor/package.json+lockfile、vendor 下 better-sqlite3 文件名），SOP 见 `docs/如何构建 certd.md`「七、升级维护」，其中两处已由构建期护栏兜底。
- 文档中「离线化」措辞统一为「构建提速 + 去 GitHub 依赖」，避免误导。
