/// <reference types="mocha" />
/// <reference types="node" />

import assert from "node:assert/strict";

import { checkStatementAllowed, firstKeyword, validateDbExecReq } from "./dbtool-service.js";

describe("dbtool checkStatementAllowed", () => {
  it("放行 SELECT/SHOW/DESC/EXPLAIN/INSERT/UPDATE", () => {
    assert.doesNotThrow(() => checkStatementAllowed("select 1"));
    assert.doesNotThrow(() => checkStatementAllowed(" INSERT INTO t values (1)"));
    assert.doesNotThrow(() => checkStatementAllowed("update t set a = 1"));
    assert.doesNotThrow(() => checkStatementAllowed("show tables"));
    assert.doesNotThrow(() => checkStatementAllowed("desc t"));
    assert.doesNotThrow(() => checkStatementAllowed("explain select 1"));
  });

  it("拒绝白名单外的语句（DELETE/TRUNCATE/DROP/ALTER/CREATE/GRANT）", () => {
    assert.throws(() => checkStatementAllowed("delete from t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("  Delete From t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("truncate table t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("drop table t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("alter table t add c int"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("create table t (id int)"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("grant all on *.* to u"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("call p()"), /不允许执行该语句/);
  });

  it("剥掉开头注释后再判断", () => {
    assert.throws(() => checkStatementAllowed("-- 先看看\ndelete from t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("# 注释\ntruncate t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("/* 块注释 */ drop table t"), /不允许执行该语句/);
    assert.throws(() => checkStatementAllowed("/* 多行\n注释\n*/\n-- 再来一行\nDELETE FROM t"), /不允许执行该语句/);
    assert.doesNotThrow(() => checkStatementAllowed("-- delete from t\nselect 1"));
  });

  it("字符串字面量里的关键词不影响判断", () => {
    assert.doesNotThrow(() => checkStatementAllowed("select 'delete from t'"));
    assert.doesNotThrow(() => checkStatementAllowed("update t set note = 'truncate'"));
  });

  it("firstKeyword 取首词并大写", () => {
    assert.equal(firstKeyword("  select 1"), "SELECT");
    assert.equal(firstKeyword("-- x\nupdate t"), "UPDATE");
    assert.equal(firstKeyword(" /* c */ # d\n insert into t values (1)"), "INSERT");
    assert.equal(firstKeyword("-- 只有注释"), "");
  });
});

describe("dbtool validateDbExecReq", () => {
  const validReq = {
    host: "127.0.0.1",
    user: "root",
    password: "x",
    sql: "select 1",
  };

  it("接受最小合法请求", () => {
    assert.doesNotThrow(() => validateDbExecReq(validReq as any));
  });

  it("请求体为空时报错", () => {
    assert.throws(() => validateDbExecReq(null as any), /请求体不能为空/);
  });

  it("缺少 host/user/password/sql 时报错", () => {
    assert.throws(() => validateDbExecReq({ ...validReq, host: "" } as any), /host 不能为空/);
    assert.throws(() => validateDbExecReq({ ...validReq, user: "" } as any), /user 不能为空/);
    assert.throws(() => validateDbExecReq({ ...validReq, password: null } as any), /password 不能为空/);
    assert.throws(() => validateDbExecReq({ ...validReq, sql: "  " } as any), /sql 不能为空/);
  });

  it("port 越界或非整数时报错", () => {
    assert.throws(() => validateDbExecReq({ ...validReq, port: 0 } as any), /port 必须是/);
    assert.throws(() => validateDbExecReq({ ...validReq, port: 65536 } as any), /port 必须是/);
    assert.throws(() => validateDbExecReq({ ...validReq, port: 3306.5 } as any), /port 必须是/);
    assert.doesNotThrow(() => validateDbExecReq({ ...validReq, port: 3307 } as any));
  });

  it("maxRows 超出上限时报错", () => {
    assert.throws(() => validateDbExecReq({ ...validReq, maxRows: 0 } as any), /maxRows 必须是/);
    assert.throws(() => validateDbExecReq({ ...validReq, maxRows: 1001 } as any), /maxRows 必须是/);
    assert.doesNotThrow(() => validateDbExecReq({ ...validReq, maxRows: 1000 } as any));
  });
});
