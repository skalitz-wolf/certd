import { logger, safePromise, utils } from "@certd/basic";
import { merge } from "lodash-es";
import https from "https";
import dns from "dns";
import { PeerCertificate } from "tls";
import { DnsCustom } from "./dns-custom.js";
import { HostWhitelist } from "../../../utils/host-whitelist.js";

export type SiteTestReq = {
  host: string; // 只用域名部分
  port?: number;
  method?: string;
  retryTimes?: number;
  ipAddress?: string;

  customDns?: DnsCustom;

  /**
   * 站点监控目标白名单（SSRF防护），逗号分隔，为空表示不限制
   */
  whitelist?: string;
};

export type SiteTestRes = {
  certificate?: PeerCertificate;
};

export class SiteTester {
  async test(req: SiteTestReq): Promise<SiteTestRes> {
    // SSRF防护：白名单非空时，目标（含指定IP）必须在白名单内，否则拒绝发起连接
    const whitelist = new HostWhitelist(req.whitelist);
    whitelist.assertAllowed(req.host);
    if (req.ipAddress) {
      whitelist.assertAllowed(req.ipAddress);
    }

    const req_ = { ...req };
    delete req_.customDns;
    delete req_.whitelist;
    logger.info("测试站点:", JSON.stringify(req_));
    const maxRetryTimes = req.retryTimes == null ? 3 : req.retryTimes;
    let tryCount = 0;
    let result: SiteTestRes = {};
    while (true) {
      try {
        result = await this.doTestOnce(req);
        return result;
      } catch (e) {
        tryCount++;
        if (tryCount > maxRetryTimes) {
          logger.error(`测试站点出错，已超过最大重试次数（${maxRetryTimes}）`, e.message);
          throw e;
        }
        //指数退避
        const time = 2 ** tryCount;
        logger.error(`测试站点出错，${time}s后重试(${tryCount}/${maxRetryTimes})`, e);
        await utils.sleep(time * 1000);
      }
    }
  }

  async doTestOnce(req: SiteTestReq): Promise<SiteTestRes> {
    const options: any = merge(
      {
        port: 443,
        method: "GET",
        rejectUnauthorized: false,
      },
      req
    );

    // SSRF防护（DNS rebinding）：白名单只校验了主机名，实际连到哪个 IP 取决于解析结果。
    // 用户可把自己的 dnsServer 指向恶意解析器，让白名单域名解析到内网地址，
    // 因此解析出的每个 IP 也必须过一遍白名单。
    const whitelist = new HostWhitelist(req.whitelist);
    const assertResolvedAllowed = (addresses: any[]) => {
      for (const item of addresses || []) {
        const address = typeof item === "string" ? item : item?.address;
        if (address) {
          whitelist.assertAllowed(address);
        }
      }
    };

    let customLookup = null;
    if (req.ipAddress) {
      //使用固定的ip
      const ipAddress = req.ipAddress;
      options.headers = {
        host: options.host,
        //sni
        servername: options.host,
      };
      options.host = ipAddress;
    } else if (req.customDns) {
      // 非ip address 请求时
      const customDns = req.customDns;
      customLookup = async (hostname: string, options: any, callback) => {
        const res = await customDns.lookup(hostname, options);
        if (!res || res.length === 0) {
          callback(new Error("没有解析到IP"));
          return;
        }
        try {
          assertResolvedAllowed(res);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, res);
      };
    } else if (whitelist.enabled) {
      // 未指定 IP、未使用自定义 DNS：系统解析结果同样要校验
      customLookup = async (hostname: string, options: any, callback) => {
        const res = await dns.promises.lookup(hostname, { ...options, all: true } as dns.LookupAllOptions);
        try {
          assertResolvedAllowed(res);
        } catch (e) {
          callback(e);
          return;
        }
        callback(null, res);
      };
    }

    const agentOptions: any = { keepAlive: false };
    if (customLookup) {
      agentOptions.lookup = customLookup;
    }
    options.agent = new https.Agent(agentOptions);

    // 创建 HTTPS 请求
    const requestPromise = safePromise((resolve, reject) => {
      const req = https.request(options, res => {
        res.socket.end();
        // 关闭响应
        res.destroy();
      });

      // ✅ 关键：在 'socket' 事件中获取证书（握手完成后立即执行）
      req.on("socket", (socket: any) => {
        socket.on("secureConnect", () => {
          // TLS握手完成，证书已经可用
          const certificate = socket.getPeerCertificate();
          if (certificate.subject) {
            logger.info("证书获取成功", certificate.subject);
            resolve({
              certificate,
            });
          } else {
            logger.warn("证书信息为空");
            resolve({
              certificate: null,
            });
          }
        });
      });

      req.on("error", e => {
        reject(e);
      });
      req.end();
    });

    return await requestPromise;
  }
}

export const siteTester = new SiteTester();
