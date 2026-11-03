import { Provide, Scope, ScopeEnum } from "@midwayjs/core";
import { CommonException } from "@certd/lib-server";
import mysql from "mysql2/promise";

export type DbExecReq = {
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  sql: string;
  maxRows?: number;
};

export type DbExecResult =
  | { type: "rows"; columns: string[]; rows: unknown[]; rowCount: number; truncated: boolean }
  | { type: "exec"; affectedRows: number; changedRows: number; insertId: number };

const DEFAULT_MAX_ROWS = 500;
const MAX_ROWS_LIMIT = 1000;

export const ALLOWED_STATEMENTS = ["SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "INSERT", "UPDATE"];

export function firstKeyword(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--") || s.startsWith("#")) {
      const eol = s.indexOf("\n");
      s = eol < 0 ? "" : s.slice(eol + 1);
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end < 0 ? "" : s.slice(end + 2);
      continue;
    }
    break;
  }
  const m = s.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "";
}

export function checkStatementAllowed(sql: string): void {
  const keyword = firstKeyword(sql);
  if (!ALLOWED_STATEMENTS.includes(keyword)) {
    throw new CommonException(`不允许执行该语句，仅支持 ${ALLOWED_STATEMENTS.join(" / ")}`);
  }
  // UPDATE 影响全表的风险远高于 SELECT 类语句，必须带生效条件
  if (keyword === "UPDATE") {
    assertUpdateHasWhere(sql);
  }
}

/**
 * 把字符串字面量（'...'、"..."、`...`）和注释（--、#、/* *​/）替换为等长空格，
 * 保留其余字符与位置，便于后续按位置扫描括号深度和关键词。
 * 支持 MySQL 的两种转义：反斜杠（\'）和双写（''）。
 */
export function blankStringsAndComments(sql: string): string {
  const chars = sql.split("");
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "'" || c === '"' || c === "`") {
      chars[i] = " ";
      i++;
      while (i < chars.length) {
        if (chars[i] === "\\") {
          // 反斜杠转义，连同被转义字符一起置空
          chars[i] = " ";
          if (i + 1 < chars.length) {
            chars[i + 1] = " ";
          }
          i += 2;
          continue;
        }
        if (chars[i] === c) {
          if (chars[i + 1] === c) {
            // 双写转义（''），两个都置空后继续在字符串内
            chars[i] = " ";
            chars[i + 1] = " ";
            i += 2;
            continue;
          }
          // 字符串正常结束
          chars[i] = " ";
          i++;
          break;
        }
        chars[i] = " ";
        i++;
      }
      continue;
    }
    // MySQL 的 -- 注释要求后面跟空白或行尾（否则是减号运算）
    if (c === "-" && chars[i + 1] === "-" && (chars[i + 2] === undefined || /\s/.test(chars[i + 2]))) {
      while (i < chars.length && chars[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "#") {
      while (i < chars.length && chars[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && chars[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < chars.length) {
        if (chars[i] === "*" && chars[i + 1] === "/") {
          chars[i] = " ";
          chars[i + 1] = " ";
          i += 2;
          break;
        }
        chars[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return chars.join("");
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) {
      n++;
    }
  }
  return n;
}

/**
 * 判断 WHERE 子句是否恒真（如 1=1、true、(1=1)、23=23）。
 * 只做保守判断：完整的恒真表达式才命中；
 * “恒真项 AND 真实条件”的组合不受影响。
 */
function isTriviallyTrueWhere(whereClause: string): boolean {
  const normalized = whereClause.toLowerCase().replace(/\s+/g, "");
  // 去掉首尾包裹的括号（子句可能带有 order by / limit，此时不会被这些形态命中）
  const body = normalized.replace(/^\(+/, "").replace(/\)+$/, "");
  return body === "true" || body === "1" || /^(\d+)=\1$/.test(body);
}

/**
 * UPDATE 必须在顶层（括号深度 0）带 WHERE 条件，且条件不能恒真。
 * 子查询里的 WHERE 不算外层条件；字符串/反引号/注释里的 where 已被置空，不参与判定。
 */
export function assertUpdateHasWhere(sql: string): void {
  const stripped = blankStringsAndComments(sql);
  const whereRegex = /\bwhere\b/gi;
  let match: RegExpExecArray | null;
  while ((match = whereRegex.exec(stripped)) !== null) {
    const before = stripped.slice(0, match.index);
    const depth = countChar(before, "(") - countChar(before, ")");
    if (depth !== 0) {
      // 子查询里的 WHERE，继续找外层
      continue;
    }
    const whereClause = stripped.slice(match.index + match[0].length);
    if (isTriviallyTrueWhere(whereClause)) {
      throw new CommonException("UPDATE 的 WHERE 条件恒真（如 1=1），等同于无条件全表更新，已拒绝");
    }
    return;
  }
  throw new CommonException("UPDATE 语句必须带 WHERE 条件，不允许无条件的全表更新");
}

export function validateDbExecReq(req: DbExecReq): void {
  if (!req || typeof req !== "object") {
    throw new CommonException("请求体不能为空");
  }
  if (!req.host || typeof req.host !== "string") {
    throw new CommonException("host 不能为空");
  }
  if (!req.user || typeof req.user !== "string") {
    throw new CommonException("user 不能为空");
  }
  if (req.password == null || typeof req.password !== "string") {
    throw new CommonException("password 不能为空");
  }
  if (!req.sql || typeof req.sql !== "string" || req.sql.trim() === "") {
    throw new CommonException("sql 不能为空");
  }
  const port = req.port ?? 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CommonException("port 必须是 1-65535 的整数");
  }
  const maxRows = req.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS_LIMIT) {
    throw new CommonException(`maxRows 必须是 1-${MAX_ROWS_LIMIT} 的整数`);
  }
}

@Provide()
@Scope(ScopeEnum.Request, { allowDowngrade: true })
export class DbToolService {
  async exec(req: DbExecReq): Promise<DbExecResult> {
    validateDbExecReq(req);
    checkStatementAllowed(req.sql);
    const maxRows = req.maxRows ?? DEFAULT_MAX_ROWS;

    let conn: mysql.Connection | null = null;
    try {
      conn = await mysql.createConnection({
        host: req.host,
        port: req.port ?? 3306,
        user: req.user,
        password: req.password,
        database: req.database,
        connectTimeout: 8000,
      });
      const [rows, fields] = await conn.query(req.sql);

      if (Array.isArray(rows)) {
        const columns = Array.isArray(fields) ? fields.map((f: mysql.FieldPacket) => f.name) : [];
        const truncated = rows.length > maxRows;
        return {
          type: "rows",
          columns,
          rows: truncated ? rows.slice(0, maxRows) : rows,
          rowCount: rows.length,
          truncated,
        };
      }
      const header = rows as mysql.ResultSetHeader;
      return {
        type: "exec",
        affectedRows: header.affectedRows ?? 0,
        changedRows: header.changedRows ?? 0,
        insertId: Number(header.insertId ?? 0),
      };
    } catch (e: any) {
      if (e instanceof CommonException) {
        throw e;
      }
      throw new CommonException(`执行失败: ${e?.message ?? e}`);
    } finally {
      if (conn) {
        await conn.end().catch(() => {});
      }
    }
  }
}
