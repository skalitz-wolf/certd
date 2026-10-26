/// <reference types="mocha" />
/// <reference types="node" />

import assert from "node:assert/strict";

import { HostWhitelist } from "./host-whitelist.js";

describe("HostWhitelist", () => {
  it("空白名单放行公网目标，但仍拒绝内网地址", () => {
    assert.equal(new HostWhitelist().enabled, false);
    assert.equal(new HostWhitelist("").enabled, false);
    assert.equal(new HostWhitelist("  , ,").enabled, false);
    assert.equal(new HostWhitelist([]).enabled, false);

    const whitelist = new HostWhitelist();
    assert.equal(whitelist.isAllowed("example.com"), true);
    assert.equal(whitelist.isAllowed("8.8.8.8"), true);
    // 内网/保留地址默认拒绝（SSRF防护），不受白名单开关影响
    assert.equal(whitelist.isAllowed("192.168.1.1"), false);
    assert.equal(whitelist.isAllowed("127.0.0.1"), false);
    assert.equal(whitelist.isAllowed("169.254.169.254"), false);
    assert.equal(whitelist.isAllowed("10.0.0.1"), false);
    assert.equal(whitelist.isAllowed("::1"), false);
    assert.equal(whitelist.isAllowed("fd00::1"), false);
    // 无法归一化的输入按拒绝处理
    assert.equal(whitelist.isAllowed(undefined), false);
  });

  it("内网地址可通过白名单显式放行", () => {
    const whitelist = new HostWhitelist("192.168.1.0/24,10.0.0.5");
    assert.equal(whitelist.isAllowed("192.168.1.100"), true);
    assert.equal(whitelist.isAllowed("10.0.0.5"), true);
    assert.equal(whitelist.isAllowed("10.0.0.6"), false);
    assert.equal(whitelist.isAllowed("192.168.2.1"), false);
  });

  it("精确域名匹配，大小写不敏感", () => {
    const whitelist = new HostWhitelist("example.com");
    assert.equal(whitelist.isAllowed("example.com"), true);
    assert.equal(whitelist.isAllowed("EXAMPLE.COM"), true);
    // 末尾根域名点等价
    assert.equal(whitelist.isAllowed("example.com."), true);
    // 子域名不匹配精确域名
    assert.equal(whitelist.isAllowed("sub.example.com"), false);
    assert.equal(whitelist.isAllowed("other.com"), false);
    // 相似域名后缀不能误匹配
    assert.equal(whitelist.isAllowed("notexample.com"), false);
  });

  it("通配域名匹配所有子域名，但不包含域名本身", () => {
    const whitelist = new HostWhitelist("*.example.com");
    assert.equal(whitelist.isAllowed("sub.example.com"), true);
    assert.equal(whitelist.isAllowed("a.b.example.com"), true);
    assert.equal(whitelist.isAllowed("SUB.EXAMPLE.COM"), true);
    // 通配不包含裸域名本身
    assert.equal(whitelist.isAllowed("example.com"), false);
    assert.equal(whitelist.isAllowed("other.com"), false);
    assert.equal(whitelist.isAllowed("fakeexample.com"), false);
  });

  it("精确IP匹配", () => {
    const whitelist = new HostWhitelist("1.2.3.4,::1");
    assert.equal(whitelist.isAllowed("1.2.3.4"), true);
    assert.equal(whitelist.isAllowed("::1"), true);
    assert.equal(whitelist.isAllowed("1.2.3.5"), false);
    assert.equal(whitelist.isAllowed("127.0.0.1"), false);
  });

  it("CIDR网段匹配", () => {
    const whitelist = new HostWhitelist("10.0.0.0/8,fd00::/8");
    assert.equal(whitelist.isAllowed("10.1.2.3"), true);
    assert.equal(whitelist.isAllowed("10.255.255.255"), true);
    assert.equal(whitelist.isAllowed("fd00::1"), true);
    assert.equal(whitelist.isAllowed("192.168.1.1"), false);
    assert.equal(whitelist.isAllowed("11.0.0.1"), false);
    assert.equal(whitelist.isAllowed("fe80::1"), false);
  });

  it("域名条目不会放行解析到该IP之外的地址，IP目标只按IP条目匹配", () => {
    // 白名单只有域名条目时，IP字面量一律不允许
    const domainOnly = new HostWhitelist("example.com");
    assert.equal(domainOnly.isAllowed("93.184.216.34"), false);
  });

  it("混合条目配置", () => {
    const whitelist = new HostWhitelist(" jxlife.com.cn , *.jxlife.com.cn, 10.10.1.5 ,172.20.0.0/16,,");
    assert.equal(whitelist.enabled, true);
    assert.equal(whitelist.isAllowed("jxlife.com.cn"), true);
    assert.equal(whitelist.isAllowed("certd.tst.jxlife.com.cn"), true);
    assert.equal(whitelist.isAllowed("10.10.1.5"), true);
    assert.equal(whitelist.isAllowed("172.20.3.4"), true);
    assert.equal(whitelist.isAllowed("192.168.1.1"), false);
    assert.equal(whitelist.isAllowed("evil.com"), false);
  });

  it("非法条目被忽略且不会意外放行", () => {
    const whitelist = new HostWhitelist("not_cidr/xx,256.1.1.1/8");
    assert.equal(whitelist.isAllowed("not_cidr"), false);
    assert.equal(whitelist.isAllowed("256.1.1.1"), false);
  });

  it("assertAllowed 对不允许的目标抛出异常", () => {
    const whitelist = new HostWhitelist("example.com");
    whitelist.assertAllowed("example.com");
    assert.throws(() => whitelist.assertAllowed("192.168.1.1"), /不在站点监控白名单内/);
    assert.throws(() => whitelist.assertAllowed(undefined), /不在站点监控白名单内/);

    // 空白名单放行公网目标
    const empty = new HostWhitelist("");
    empty.assertAllowed("example.com");
    // 但内网地址仍被拒绝
    assert.throws(() => empty.assertAllowed("192.168.1.1"), /不在站点监控白名单内/);
  });

  it("支持数组形式配置", () => {
    const whitelist = new HostWhitelist(["example.com", "10.0.0.0/8"]);
    assert.equal(whitelist.isAllowed("example.com"), true);
    assert.equal(whitelist.isAllowed("10.1.1.1"), true);
    assert.equal(whitelist.isAllowed("other.com"), false);
  });
});
