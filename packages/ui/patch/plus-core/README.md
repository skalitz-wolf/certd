# plus-core 本地试用补丁

## 背景

官方试用（`/api/sys/plus/getVipTrial`）需要 certd 服务器能访问远程 plus 服务器
（`https://api.handfree.work/api`）。部署环境出方向网络不通时无法领取试用。

## 补丁内容

本目录的 `index.js` 基于 `@certd/plus-core@1.43.0` 的 `dist/index.js`，仅改动一处：
`verifySignature` 方法放行 `signature` 为哨兵值 `"local-trial"` 的 license，
其余（包括真实 license 的 RSA-SHA256 验签）逻辑完全不变。

> **版本基线**：镜像实际安装的是 `1.42.6`（见 `packages/ui/vendor/pnpm-lock.yaml`），
> 补丁基于 `1.43.0` 制作。两者逐字符对比仅差补丁这一行，已验证兼容。

配合 `packages/ui/certd-server` 中 `SysPlusController.getVipTrial` 的本地试用逻辑：
它直接构造一个本地 license（`vipType: "plus"`，默认时长 365000 天，可用环境变量
`CERTD_LOCAL_TRIAL_DAYS` 覆盖），不走远程接口，并写入 `sys.license` 设置持久化。

> 该逻辑必须放在 `packages/ui/certd-server` 里，不能放 `packages/libs/lib-server`：
> 镜像构建上下文只有 `packages/ui/`，`@certd/*` 依赖从 npm registry 解析，
> 改 `lib-server` 源码不会进入镜像（2026-10 实测：镜像内仍是 npm 上的原版实现，
> `getVipTrial` 走远程接口，120 秒后 502）。

## 同步到本地 node_modules（本地开发时）

`pnpm install` 会覆盖 node_modules，重装后需重新同步（版本号按实际安装版本调整，本地当前是 1.43.0）：

```bash
cp packages/ui/patch/plus-core/index.js \
  node_modules/.pnpm/@certd+plus-core@1.43.0/node_modules/@certd/plus-core/dist/index.js
```

## 升级 plus-core 时的检查清单

1. 从新的 `dist/index.js` 里找到 `verifySignature(e,i,s){`，在其开头插入 `if("local-trial"===i)return!0;`
2. 替换 `packages/ui/patch/plus-core/index.js`，并更新本文档的版本基线说明
3. 同步到本地 node_modules（见上），跑一次 `getVipTrial` 确认返回 `isPlus: true`
4. 重新构建镜像——Dockerfile 会在补丁未生效时中断构建

## Docker 镜像

`packages/ui/Dockerfile` 已在运行时阶段加入拷贝步骤（glob 匹配任意 plus-core 版本），
并校验补丁确实生效，否则构建失败。构建出的镜像自带本补丁，无需手动操作。

## 注意

- 本补丁仅用于网络受限环境下**临时评估**专业版功能，请勿用于长期生产用途；
  长期使用请购买官方授权（`active` 激活码流程不受本补丁影响）。
- 若部署环境后来能访问远程 plus 服务器，定时远程校验（启动后约 20 秒、之后每 11 小时）
  会发现本地 license 无效并自动退回基础版——这是预期行为，届时请走官方试用/购买流程。
- 升级 `@certd/plus-core` 版本后需重做补丁，见上文「升级 plus-core 时的检查清单」。
