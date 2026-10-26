/// <reference types="mocha" />
/// <reference types="node" />

import assert from "node:assert/strict";

import { checkRedisCommandAllowed, encodeCommand, parseResp, validateRedisExecReq } from "./redistool-service.js";

describe("redistool checkRedisCommandAllowed", () => {
  it("放行白名单命令且大小写不敏感", () => {
    assert.equal(checkRedisCommandAllowed("get"), "GET");
    assert.equal(checkRedisCommandAllowed("  HGetAll "), "HGETALL");
    assert.doesNotThrow(() => checkRedisCommandAllowed("scan"));
  });

  it("拒绝白名单外命令", () => {
    for (const cmd of ["FLUSHALL", "FLUSHDB", "SHUTDOWN", "CONFIG", "DEBUG", "EVAL", "SCRIPT", "RENAME", "MOVE"]) {
      assert.throws(() => checkRedisCommandAllowed(cmd), /不允许执行该命令/, cmd);
    }
  });

  it("空命令报错", () => {
    assert.throws(() => checkRedisCommandAllowed(""), /command 不能为空/);
    assert.throws(() => checkRedisCommandAllowed(undefined as any), /command 不能为空/);
  });
});

describe("redistool validateRedisExecReq", () => {
  const valid = { host: "127.0.0.1", command: "GET", args: ["k"] };

  it("接受最小合法请求", () => {
    assert.doesNotThrow(() => validateRedisExecReq(valid as any));
  });

  it("校验 host/port/db/timeoutMs/args", () => {
    assert.throws(() => validateRedisExecReq({ ...valid, host: "" } as any), /host 不能为空/);
    assert.throws(() => validateRedisExecReq({ ...valid, port: 0 } as any), /port 必须是/);
    assert.throws(() => validateRedisExecReq({ ...valid, port: 70000 } as any), /port 必须是/);
    assert.throws(() => validateRedisExecReq({ ...valid, db: -1 } as any), /db 必须是非负整数/);
    assert.throws(() => validateRedisExecReq({ ...valid, timeoutMs: 100 } as any), /timeoutMs 必须是/);
    assert.throws(() => validateRedisExecReq({ ...valid, timeoutMs: 60000 } as any), /timeoutMs 必须是/);
    assert.throws(() => validateRedisExecReq({ ...valid, args: "k" } as any), /args 必须是数组/);
  });

  it("args 数量上限", () => {
    const args = new Array(1001).fill("x");
    assert.throws(() => validateRedisExecReq({ ...valid, args } as any), /args 最多/);
  });
});

describe("redistool encodeCommand", () => {
  it("按 RESP 数组编码", () => {
    assert.equal(encodeCommand(["GET", "foo"]).toString(), "*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n");
  });

  it("按字节长度编码中文", () => {
    const enc = encodeCommand(["SET", "键", "值"]).toString();
    // "键" 为 UTF-8 三字节，长度前缀必须是字节数而非字符数
    assert.ok(enc.includes("$3\r\n键"));
  });
});

describe("redistool parseResp", () => {
  it("解析简单字符串、整数、错误、空值", () => {
    assert.deepEqual(parseResp(Buffer.from("+OK\r\n"))?.value, "OK");
    assert.deepEqual(parseResp(Buffer.from(":42\r\n"))?.value, 42);
    assert.ok(parseResp(Buffer.from("-ERR bad\r\n"))?.value instanceof Error);
    assert.equal(parseResp(Buffer.from("$-1\r\n"))?.value, null);
  });

  it("解析 bulk string 与数组", () => {
    assert.equal(parseResp(Buffer.from("$3\r\nfoo\r\n"))?.value, "foo");
    const arr = parseResp(Buffer.from("*3\r\n$1\r\na\r\n$1\r\nb\r\n:2\r\n"));
    assert.deepEqual(arr?.value, ["a", "b", 2]);
  });

  it("嵌套数组", () => {
    const nested = parseResp(Buffer.from("*2\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n$1\r\nc\r\n"));
    assert.deepEqual(nested?.value, [["a", "b"], "c"]);
  });

  it("数据不完整时返回 undefined", () => {
    assert.equal(parseResp(Buffer.from("$5\r\nfoo")), undefined);
    assert.equal(parseResp(Buffer.from("*2\r\n$1\r\na\r\n")), undefined);
    assert.equal(parseResp(Buffer.from("+OK")), undefined);
  });

  it("正确报告 consumed", () => {
    const parsed = parseResp(Buffer.from("$3\r\nfoo\r\n+OK\r\n"));
    assert.equal(parsed?.consumed, 9);
  });
});
