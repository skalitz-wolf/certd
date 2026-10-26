import { Provide, Scope, ScopeEnum } from "@midwayjs/core";
import { CommonException } from "@certd/lib-server";
import net from "node:net";

export type RedisExecReq = {
  host: string;
  port?: number;
  password?: string;
  db?: number;
  command: string;
  args?: unknown[];
  timeoutMs?: number;
};

export type RedisExecResult = {
  type: string;
  value: unknown;
};

export const ALLOWED_COMMANDS = [
  "GET",
  "MGET",
  "EXISTS",
  "TTL",
  "PTTL",
  "TYPE",
  "KEYS",
  "SCAN",
  "DBSIZE",
  "INFO",
  "HGET",
  "HGETALL",
  "HMGET",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "SMEMBERS",
  "SISMEMBER",
  "SCARD",
  "ZRANGE",
  "ZSCORE",
  "ZCARD",
  "ZRANGEBYSCORE",
  "SET",
  "SETEX",
  "HSET",
  "HDEL",
  "DEL",
  "EXPIRE",
  "PERSIST",
  "INCR",
  "DECR",
  "LPUSH",
  "RPUSH",
  "SADD",
  "SREM",
  "ZADD",
  "ZREM",
];

const DEFAULT_PORT = 6379;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30000;
const MAX_ARGS = 1000;

export function checkRedisCommandAllowed(command: string): string {
  const cmd = String(command ?? "").trim().toUpperCase();
  if (!cmd) {
    throw new CommonException("command 不能为空");
  }
  if (!ALLOWED_COMMANDS.includes(cmd)) {
    throw new CommonException(`不允许执行该命令，仅支持 ${ALLOWED_COMMANDS.join(" / ")}`);
  }
  return cmd;
}

export function validateRedisExecReq(req: RedisExecReq): void {
  if (!req || typeof req !== "object") {
    throw new CommonException("请求体不能为空");
  }
  if (!req.host || typeof req.host !== "string") {
    throw new CommonException("host 不能为空");
  }
  checkRedisCommandAllowed(req.command);

  const port = req.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CommonException("port 必须是 1-65535 的整数");
  }
  if (req.db != null && (!Number.isInteger(req.db) || req.db < 0)) {
    throw new CommonException("db 必须是非负整数");
  }
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new CommonException(`timeoutMs 必须是 1000-${MAX_TIMEOUT_MS} 的整数`);
  }
  if (req.args != null && !Array.isArray(req.args)) {
    throw new CommonException("args 必须是数组");
  }
  if ((req.args?.length ?? 0) > MAX_ARGS) {
    throw new CommonException(`args 最多 ${MAX_ARGS} 个`);
  }
}

// RESP 编码：所有参数按 bulk string 发送，不做字符串拼接，天然免疫命令注入
export function encodeCommand(parts: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const p of parts) {
    const buf = Buffer.from(p, "utf8");
    chunks.push(Buffer.from(`$${buf.length}\r\n`), buf, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

export type RespValue = string | number | null | RespValue[] | Error;

// 解析一个 RESP 值；数据不足时返回 undefined（等待更多字节）
export function parseResp(buf: Buffer, offset = 0): { value: RespValue; consumed: number } | undefined {
  if (offset >= buf.length) return undefined;
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd < 0) return undefined;

  const marker = String.fromCharCode(buf[offset]);
  const line = buf.slice(offset + 1, lineEnd).toString("utf8");
  const afterLine = lineEnd + 2;

  switch (marker) {
    case "+":
      return { value: line, consumed: afterLine - offset };
    case "-":
      return { value: new Error(line), consumed: afterLine - offset };
    case ":":
      return { value: Number(line), consumed: afterLine - offset };
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, consumed: afterLine - offset };
      if (buf.length < afterLine + len + 2) return undefined;
      const str = buf.slice(afterLine, afterLine + len).toString("utf8");
      return { value: str, consumed: afterLine + len + 2 - offset };
    }
    case "*": {
      const count = Number(line);
      if (count < 0) return { value: null, consumed: afterLine - offset };
      const items: RespValue[] = [];
      let pos = afterLine;
      for (let i = 0; i < count; i++) {
        const sub = parseResp(buf, pos);
        if (!sub) return undefined;
        items.push(sub.value);
        pos += sub.consumed;
      }
      return { value: items, consumed: pos - offset };
    }
    default:
      return { value: line, consumed: afterLine - offset };
  }
}

type Step = { parts: string[]; onOk: () => void };

@Provide()
@Scope(ScopeEnum.Request, { allowDowngrade: true })
export class RedisToolService {
  async exec(req: RedisExecReq): Promise<RedisExecResult> {
    validateRedisExecReq(req);
    const cmd = checkRedisCommandAllowed(req.command);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const port = req.port ?? DEFAULT_PORT;

    // 握手链：AUTH（可选）→ SELECT（可选，非 0 库）→ 真正的命令
    const steps: Step[] = [];
    if (req.password) {
      steps.push({ parts: ["AUTH", req.password], onOk: () => {} });
    }
    if (req.db != null && req.db !== 0) {
      steps.push({ parts: ["SELECT", String(req.db)], onOk: () => {} });
    }
    steps.push({ parts: [cmd, ...(req.args ?? []).map(a => String(a))], onOk: () => {} });

    return await new Promise<RedisExecResult>((resolve, reject) => {
      const socket = net.createConnection({ host: req.host, port });
      let buffer = Buffer.alloc(0);
      let stepIndex = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new CommonException(`连接或执行超时（${timeoutMs}ms）`)));
      }, timeoutMs);

      const sendNext = () => {
        if (stepIndex >= steps.length) return;
        socket.write(encodeCommand(steps[stepIndex].parts));
      };

      socket.on("connect", () => {
        stepIndex = 0;
        sendNext();
      });

      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = parseResp(buffer, 0);
          if (!parsed) return;
          buffer = buffer.slice(parsed.consumed);

          const isLast = stepIndex === steps.length - 1;
          if (parsed.value instanceof Error) {
            const stage = isLast ? "执行失败" : "认证或选择库失败";
            finish(() => reject(new CommonException(`${stage}: ${(parsed.value as Error).message}`)));
            return;
          }
          if (isLast) {
            finish(() => resolve({ type: cmd, value: parsed.value }));
            return;
          }
          stepIndex += 1;
          sendNext();
        }
      });

      socket.on("error", e => {
        finish(() => reject(new CommonException(`连接失败: ${e.message}`)));
      });

      socket.on("close", () => {
        finish(() => reject(new CommonException("连接已关闭，未收到响应")));
      });
    });
  }
}
