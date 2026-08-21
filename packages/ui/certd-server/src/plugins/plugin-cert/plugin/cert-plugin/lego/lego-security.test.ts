/// <reference types="mocha" />
/// <reference types="node" />

import assert from "node:assert/strict";

import { assertSafeLegoArg, assertValidLegoAcmeServer, assertValidLegoDnsType, assertValidLegoDomain, assertValidLegoEab, assertValidLegoEmail, assertValidLegoPrivateKeyType } from "./lego-security.js";

describe("lego-security", () => {
  describe("assertSafeLegoArg（自定义参数）", () => {
    it("正常的 lego 参数可通过", () => {
      assertSafeLegoArg("--dns-timeout 30", "自定义参数");
      assertSafeLegoArg("--no-bundle", "自定义参数");
      assertSafeLegoArg(`--preferred-chain "ISRG Root X1"`, "自定义参数");
      assertSafeLegoArg("-k ec256 --key-type ecdsa", "自定义参数");
      assertSafeLegoArg("--dns.resolvers=1.1.1.1,8.8.8.8", "自定义参数");
      assertSafeLegoArg(undefined, "自定义参数");
      assertSafeLegoArg("", "自定义参数");
    });

    it("拒绝命令注入字符", () => {
      // PoC 中的注入载荷
      assert.throws(() => assertSafeLegoArg("; echo __RCE_START__; whoami; uname -a; echo __RCE_END__; #", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo | id", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo & id", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo `id`", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo $(id)", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo > /tmp/x", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo < /etc/passwd", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo *", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo ?", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo {id}", "自定义参数"), /不允许的字符/);
      assert.throws(() => assertSafeLegoArg("--foo \\x3bwhoami", "自定义参数"), /不允许的字符/);
    });

    it("拒绝换行符", () => {
      assert.throws(() => assertSafeLegoArg("--foo\nwhoami", "自定义参数"), /不能包含换行符/);
      assert.throws(() => assertSafeLegoArg("--foo\rwhoami", "自定义参数"), /不能包含换行符/);
    });
  });

  describe("assertValidLegoEmail", () => {
    it("正常邮箱可通过", () => {
      assertValidLegoEmail("test@example.com");
      assertValidLegoEmail("a.b+tag@sub.example.com.cn");
    });

    it("拒绝非法邮箱和注入载荷", () => {
      assert.throws(() => assertValidLegoEmail("test@example.com; whoami"), /格式不正确/);
      assert.throws(() => assertValidLegoEmail("test@example.com | id"), /格式不正确/);
      assert.throws(() => assertValidLegoEmail("not-an-email"), /格式不正确/);
      assert.throws(() => assertValidLegoEmail(undefined), /格式不正确/);
    });
  });

  describe("assertValidLegoDnsType", () => {
    it("正常 DNS 类型可通过", () => {
      assertValidLegoDnsType("alidns");
      assertValidLegoDnsType("cloudflare");
      assertValidLegoDnsType("dns_provider_1");
    });

    it("拒绝注入载荷", () => {
      assert.throws(() => assertValidLegoDnsType("alidns; id"), /格式不正确/);
      assert.throws(() => assertValidLegoDnsType("alidns|id"), /格式不正确/);
      assert.throws(() => assertValidLegoDnsType(""), /格式不正确/);
    });
  });

  describe("assertValidLegoDomain", () => {
    it("正常域名、泛域名、IP 可通过", () => {
      assertValidLegoDomain("example.com");
      assertValidLegoDomain("*.example.com");
      assertValidLegoDomain("a.b.example.com.cn");
      assertValidLegoDomain("123.123.123.123");
      assertValidLegoDomain("sub-example.com");
    });

    it("拒绝注入载荷", () => {
      assert.throws(() => assertValidLegoDomain("example.com; whoami"), /格式不正确/);
      assert.throws(() => assertValidLegoDomain("example.com | id"), /格式不正确/);
      assert.throws(() => assertValidLegoDomain("example.com`id`"), /格式不正确/);
      assert.throws(() => assertValidLegoDomain("example.com$(id)"), /格式不正确/);
      assert.throws(() => assertValidLegoDomain("-d x.com"), /格式不正确/);
    });
  });

  describe("assertValidLegoPrivateKeyType", () => {
    it("合法类型可通过", () => {
      for (const t of ["rsa2048", "rsa3072", "rsa4096", "rsa8192", "ec256", "ec384", "ec_521"]) {
        assertValidLegoPrivateKeyType(t);
      }
    });

    it("拒绝非法类型和注入载荷", () => {
      assert.throws(() => assertValidLegoPrivateKeyType("ec256; id"), /不在允许范围/);
      assert.throws(() => assertValidLegoPrivateKeyType("rsa2048$(id)"), /不在允许范围/);
      assert.throws(() => assertValidLegoPrivateKeyType(undefined), /不在允许范围/);
    });
  });

  describe("assertValidLegoAcmeServer", () => {
    it("合法的 https 地址可通过", () => {
      assertValidLegoAcmeServer("https://acme-v02.api.letsencrypt.org/directory");
      assertValidLegoAcmeServer(undefined);
    });

    it("拒绝非 https 或含注入字符的地址", () => {
      assert.throws(() => assertValidLegoAcmeServer("http://evil.com/directory"), /必须使用 https/);
      assert.throws(() => assertValidLegoAcmeServer("https://evil.com/directory; whoami"), /不允许的特殊字符/);
      assert.throws(() => assertValidLegoAcmeServer("not a url"), /格式不正确/);
    });
  });

  describe("assertValidLegoEab", () => {
    it("正常的 EAB 凭证可通过", () => {
      assertValidLegoEab("kid_123", "abc==/+-_.");
      assertValidLegoEab(undefined, undefined);
    });

    it("拒绝包含 shell 字符的凭证", () => {
      assert.throws(() => assertValidLegoEab("kid; id", "hmac"), /kid/);
      assert.throws(() => assertValidLegoEab("kid", "hmac$(id)"), /hmacKey/);
    });
  });
});
