# plus-core 本地试用补丁

## 背景

官方试用（`/api/sys/plus/getVipTrial`）需要 certd 服务器能访问远程 plus 服务器
（`https://api.handfree.work/api`）。部署环境出方向网络不通时无法领取试用。

## 补丁内容

本目录的 `index.js` 基于 `@certd/plus-core@1.43.0` 的 `dist/index.js`，仅改动一处：
`verifySignature` 方法放行 `signature` 为哨兵值 `"local-trial"` 的 license，
其余（包括真实 license 的 RSA-SHA256 验签）逻辑完全不变。

配合 `packages/libs/lib-server` 中 `PlusService.getVipTrial` 的本地试用逻辑：
它在网络不通时直接构造一个 **7 天后自动过期** 的本地 license（`vipType: "plus"`），
不走远程接口。过期后 `localVerify` 会判定"授权已过期"退回基础版，想续期需重新构造。

## 同步到本地 node_modules（本地开发时）

`pnpm install` 会覆盖 node_modules，重装后需重新同步（路径里的版本号按实际安装版本调整）：

```bash
cp packages/ui/patch/plus-core/index.js \
  node_modules/.pnpm/@certd+plus-core@1.43.0/node_modules/@certd/plus-core/dist/index.js
```

## Docker 镜像

`packages/ui/Dockerfile` 已在运行时阶段加入拷贝步骤（glob 匹配任意 plus-core 版本），
构建出的镜像自带本补丁，无需手动操作。

## 注意

- 本补丁仅用于网络受限环境下**临时评估**专业版功能，请勿用于长期生产用途；
  长期使用请购买官方授权（`active` 激活码流程不受本补丁影响）。
- 若部署环境后来能访问远程 plus 服务器，定时远程校验（启动后约 20 秒、之后每 11 小时）
  会发现本地 license 无效并自动退回基础版——这是预期行为，届时请走官方试用/购买流程。
- 升级 `@certd/plus-core` 版本后，需基于新版 `dist/index.js` 重新制作本补丁
  （在 `verifySignature(e,i,s){` 开头插入 `if("local-trial"===i)return!0;`）。
