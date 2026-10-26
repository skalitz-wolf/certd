# 专业版试用走本地 license + plus-core 验签补丁，不访问远程授权服务器

官方试用需要 certd 服务器访问 `api.handfree.work` 领取 license。部署环境出方向网络不通，官方流程不可用。

做法：`SysPlusController.getVipTrial` 直接构造 `signature: "local-trial"` 的 license，写入 `sys.license` 设置，再调 `verifyLocalOnly()` 本地校验。配套补丁 `packages/ui/patch/plus-core/index.js` 在 plus-core 的 `verifySignature` 开头放行这个哨兵值，其余验签逻辑不变。

## 关键约束

- **补丁绑定 minified bundle**：补丁是完整替换 `dist/index.js`，不是打 diff。plus-core 升级后必须基于新 bundle 重做（在 `verifySignature(e,i,s){` 开头插入 `if("local-trial"===i)return!0;`）。
- **plus-core 版本必须锁死**：`vendor/pnpm-lock.yaml` 锁 1.42.6。若 `certd-server/package.json` 的 `^1.42.6` 导致重新解析到 1.43+，补丁会静默失效——Dockerfile 已加构建期校验（找不到或未生效则中断构建）。
- **网络能通时会失效**：plus-core 启动后 20 秒、之后每 11 小时做远程校验，会判定本地 license 无效并退回基础版。远程请求失败（网络不通）则保持有效。

## 考虑过的替代方案

- **fork plus-core 发内网包**：工程上更干净，但等于长期维护一个分叉的商业授权库，负担更重。
- **购买官方授权**：唯一没有长期负债的选项，当前不采用。

选定的方案是临时性最强的那个：负担小、但每次升级 plus-core 都要重做补丁。

## Consequences

- 升级 plus-core 是高风险操作，必须重做补丁并跑一次 `getVipTrial` 验证。
- 补丁绕过的是商业授权校验，法务风险由使用者承担，仅用于网络受限环境下的临时评估。
- 若部署环境后来能访问远程授权服务器，定时校验会让 license 失效——这是预期行为。
