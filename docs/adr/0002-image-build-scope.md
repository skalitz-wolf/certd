# 镜像构建只含 packages/ui：服务端改动必须落在 certd-server，不能改 packages/libs

`packages/ui/Dockerfile` 的构建上下文是 `packages/ui/`，依赖层用 `vendor/package.json` + `vendor/pnpm-lock.yaml` 从 npm registry 解析 `@certd/*`。仓库根的 `pnpm-workspace.yaml` 不在构建上下文内，容器里没有 workspace 概念。

结论：**镜像里跑的 `@certd/lib-server`、`@certd/plugin-lib` 等，是 npm 上已发布的版本，不是本仓库 `packages/libs` / `packages/plugins` 下的源码。** 改这些目录不会影响镜像。

2026-10-23 的提交 `d5832f7c0` 把本地试用逻辑改在 `packages/libs/lib-server/.../plus-service.ts`，构建出的镜像里仍是 npm 原版——`getVipTrial` 走远程接口，网络不通时 120 秒后 502。排查了一天，最后把逻辑移到 `packages/ui/certd-server` 才生效（`4a2d76a7d`）。

## 考虑过的替代方案

- **把 `packages/libs` 纳入构建上下文做 workspace 构建**：镜像能用本地源码，但构建变慢，且失去「依赖层缓存不随源码失效」的优化（现在源码改动后重建约 3.5 分钟，全量装依赖约 5~8 分钟）。当前 `packages/libs` 里没有需要保留的改动，暂不采用。
- **只 vendor 改动过的包**（打包成 tgz 放 `packages/ui/vendor`，Dockerfile 覆盖安装）：可行，但每次改 libs 都要重新打包，容易忘记。
- **选定的做法**：服务端改动一律写在 `packages/ui/certd-server` 内。若必须修改 libs/plugins 里的行为，在 certd-server 侧包一层（例如 `base-convert.ts` 在调用 `CertConverter` 前先校验参数）。

## Consequences

- `packages/plugins/plugin-lib` 里的命令注入点（`convert.ts` 的 `pfxArgs`/`pfxPassword` 拼接进 `openssl pkcs12`）在镜像里改不了，只能在上层拦截，或等上游修复后 merge。
- 判断某改动是否需要重新构建镜像：看它在 `packages/ui/` 下还是 `packages/libs`/`packages/plugins` 下。
- Dockerfile 里对 `node_modules` 的覆盖（plus-core 补丁）是显式例外，必须带构建期校验，否则会静默失效。
