# 命令注入与 SSRF 修复：一律在 certd-server 侧拦截，不改底层库

`53dd91351 修复两个漏洞` 补了 lego 插件的命令注入和站点监控的 SSRF。2026-10-26 的安全审查发现两处遗漏，且都受同一个约束限制：**漏洞所在的底层库不在镜像构建范围内**（见 ADR 0002）。

## 遗漏一：lego 的 `%VAR%` 注入（Windows）

`lego/index.ts` 把参数拼成字符串交给 `sp.spawn({ shell: true })`。原修复给 `customArgs` 等字段加了字符白名单，但：

- `environment` 字段（`KEY=VALUE` 多行）**完全未校验**，直接作为 `env` 传给 spawn
- `%` 在 `LEGO_ARG_SAFE_CHARS` 白名单内

Windows 的 `cmd.exe` 在**任何位置（含双引号内）**都会展开 `%VAR%`。因此 `environment: X=&& echo INJECTED` + `customArgs: %X%` 就能执行任意命令。`acmeServer` 同理（拼接时未加引号）。

**修法**：`environment` 的 key 用 `^[A-Za-z_][A-Za-z0-9_]*$`、value 拒绝 `%;|&`$()<>'"\\` 和换行；`LEGO_ARG_SAFE_CHARS` 和 `acmeServer` 校验都去掉/拦掉 `%`。

**为什么不改成 `shell: false` + 参数数组**：`sp.spawn` 在 `packages/core/basic`，从 npm 解析，镜像里改不了。这是本构建约束下能做到的最彻底方案，能堵掉审查给出的可复现 PoC，但不是根除——彻底修法需要上游改成 `shell: false`。

## 遗漏二：`convert.ts` 的 pfx 注入

`@certd/plugin-lib` 的 `CertConverter.convertPfx` 把 `pfxArgs` / `pfxPassword` 拼进 `openssl pkcs12 ...` 再 `spawn(shell: true)`，两者都是 `@TaskInput`，任何能建流水线的用户都能注入。这个洞在 `mine` 和 `upstream/v2` 上完全一致。

**修法**：在 `base-convert.ts` 调用 `CertConverter` 之前，用新增的 `convert-security.ts` 校验。`pfxArgs` 用字符白名单（它是固定的 openssl 参数串）；`pfxPassword` 用黑名单只拦 shell 元字符——它是用户自定的证书导出密码，白名单会误伤 `P@ssw0rd!` 这类合法值。

## SSRF：默认拒绝内网 + 校验解析结果

`HostWhitelist` 原来「空配置 = 全部放行」，且只校验主机名、不校验实际解析出的 IP。用户可把自己的 `dnsServer` 指向恶意解析器，让白名单域名解析到 `127.0.0.1:6379`（DNS rebinding）。

**修法**：

- 内网/保留网段（`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`::1`、`fc00::/7`、`fe80::/10` 等）**无论白名单是否配置都默认拒绝**，需显式加白名单放行。原来「空白名单放行一切」的语义改为「空白名单放行公网、拒绝内网」。
- `site-tester.ts` 在 `customLookup` 里对**解析结果**做白名单校验；未指定 IP 且未用自定义 DNS 时，也接管系统解析并校验。

改动前确认过：tst 和生产的站点监控都是 0 条，改默认值不影响存量数据。

## Consequences

- `host-whitelist.test.ts` 的两条断言按新语义改写（空白名单不再放行内网）。
- 底层库（`plugin-lib`、`core/basic`）里的同类问题只能在上层拦，或等上游修。已知未修：`sp.spawn` 本身仍是 `shell: true`。
- 这些测试放在 `src/` 下，`pnpm test` 不会执行（`.mocharc.json` 的 spec 是 `test/**/*.test.ts`），只有 `pnpm test:unit` 会跑。
