/// <reference types="mocha" />
/// <reference types="node" />

import assert from "node:assert/strict";

import { assertSafePfxConvert } from "./convert-security.js";

describe("convert-security", () => {
  describe("pfxArgs", () => {
    it("默认值和常见参数可通过", () => {
      assertSafePfxConvert("-macalg SHA1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES", "");
      assertSafePfxConvert("-nomac -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES", undefined);
      assertSafePfxConvert("", "");
      assertSafePfxConvert(undefined, undefined);
    });

    it("拒绝命令注入载荷", () => {
      assert.throws(() => assertSafePfxConvert("; id", ""), /不允许的字符/);
      assert.throws(() => assertSafePfxConvert("| whoami", ""), /不允许的字符/);
      assert.throws(() => assertSafePfxConvert("$(id)", ""), /不允许的字符/);
      assert.throws(() => assertSafePfxConvert("`id`", ""), /不允许的字符/);
      assert.throws(() => assertSafePfxConvert("&& echo x", ""), /不允许的字符/);
      assert.throws(() => assertSafePfxConvert("-macalg SHA1\nid", ""), /不允许的字符/);
    });
  });

  describe("pfxPassword", () => {
    it("常见密码符号可通过（黑名单不误伤）", () => {
      assertSafePfxConvert("", "P@ssw0rd!");
      assertSafePfxConvert("", "abc123");
      assertSafePfxConvert("", "a#b%c^d*e");
      assertSafePfxConvert("", "中文密码");
      assertSafePfxConvert("", "");
    });

    it("拒绝可断开命令的 shell 元字符", () => {
      assert.throws(() => assertSafePfxConvert("", "a;id"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a|id"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a&id"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a$(id)"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a`id`"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a<b"), /不能包含/);
      assert.throws(() => assertSafePfxConvert("", "a\nid"), /不能包含/);
    });
  });
});
