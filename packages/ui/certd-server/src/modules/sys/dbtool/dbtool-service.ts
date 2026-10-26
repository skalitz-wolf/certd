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
