# certd 内嵌 SQL / Redis 中转接口：环境变量开关默认关闭、guest 路由、命令白名单

certd fork 里加了两个代执行接口：`POST /api/sys/dbtool/exec`(MySQL) 与 `POST /api/sys/redistool/exec`(Redis)。动机是生产/灾备的库从办公网不可达，而 certd 服务器能直连自己的库，借此中转。

这两个接口本质是「任意语句/命令执行」，安全评审里属高危能力，因此做了三层收敛，每条都是有意为之：

- **环境变量开关默认关闭**：分别由 `CERTD_DBTOOL_ENABLED=true` / `CERTD_REDISTOOL_ENABLED=true` 开启；关闭时返回与不存在路由完全一致的 404，黑盒探测无法区分存在性。
- **guest 路由 + 手工验票**：不走 authOnly 中间件（那样未登录探测会拿到 401 暴露存在性），controller 内手工验 JWT、要求管理员角色（roles 含 1）。代价：不支持 x-certd-token 永久 Key，只能用 7 天有效的登录 token。
- **白名单**：MySQL 剥掉开头注释后取首词，只放行 `SELECT / SHOW / DESC / DESCRIBE / EXPLAIN / INSERT / UPDATE`；Redis 只放行固定的 40 余个日常命令（GET/SCAN/HGETALL/SET/HSET/DEL 等），`FLUSHALL / FLUSHDB / SHUTDOWN / CONFIG / DEBUG / SCRIPT / EVAL` 等均在白名单外。

2026-10-26 最初实现的是 MySQL 黑名单（只拦 DELETE/TRUNCATE/DROP），同日改为白名单，理由是黑名单挂一漏万（ALTER/GRANT/CREATE/CALL 都不在列）。Redis 从一开始就是白名单。

Redis 客户端用 `node:net` 手写最小 RESP 实现，不引入 ioredis——后端本无 Redis 依赖，避免为一个内部工具动 package.json。参数一律按 RESP bulk string 编码，不做字符串拼接，天然免疫命令注入；握手链 AUTH → SELECT → 实际命令。

## Consequences

- 白名单要加能力就得改常量并重新发布镜像，这是刻意的摩擦。
- 绕过方式（MySQL 的 CALL 存储过程、PREPARE 动态 SQL；Redis 的 EVAL 白名单外）理论上存在，但接口仅管理员可调，属"管理员绕自己"，不防。
- 部署镜像不带对应环境变量时该功能完全隐形、不可用。
