import net from "node:net";

/**
 * 站点监控目标白名单（SSRF防护）
 *
 * 支持四种条目格式（逗号分隔配置）：
 * 1. 精确域名：example.com（仅匹配该域名本身，大小写不敏感）
 * 2. 通配域名：*.example.com（匹配其所有子域名，不包含 example.com 本身）
 * 3. 精确IP：1.2.3.4、::1
 * 4. CIDR网段：10.0.0.0/8、fd00::/8
 *
 * 白名单为空时表示不启用限制，全部放行（兼容历史行为）
 */
export class HostWhitelist {
  /** 是否启用了白名单限制 */
  readonly enabled: boolean = false;

  /** 精确域名集合（小写） */
  private readonly domains = new Set<string>();

  /** 通配域名后缀列表（小写，已去掉 *. 前缀） */
  private readonly wildcardDomains: string[] = [];

  /** IP / CIDR 网段匹配，使用 Node 内置 BlockList */
  private readonly blockList = new net.BlockList();

  /**
   * @param whitelist 白名单配置，逗号分隔的字符串，或字符串数组
   */
  constructor(whitelist?: string | string[]) {
    const entries = HostWhitelist.splitEntries(whitelist);
    for (const entry of entries) {
      this.addEntry(entry);
    }
    this.enabled = entries.length > 0;
  }

  /** 内网/保留地址段，无论白名单是否配置都默认拒绝（需显式加白名单放行） */
  private static readonly INTERNAL_IPV4 = new net.BlockList();
  private static readonly INTERNAL_IPV6 = new net.BlockList();
  static {
    const v4 = HostWhitelist.INTERNAL_IPV4;
    v4.addSubnet("0.0.0.0", 8, "ipv4");
    v4.addSubnet("10.0.0.0", 8, "ipv4");
    v4.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
    v4.addSubnet("127.0.0.0", 8, "ipv4");
    v4.addSubnet("169.254.0.0", 16, "ipv4"); // 链路本地，含云元数据 169.254.169.254
    v4.addSubnet("172.16.0.0", 12, "ipv4");
    v4.addSubnet("192.0.0.0", 24, "ipv4");
    v4.addSubnet("192.168.0.0", 16, "ipv4");
    v4.addSubnet("198.18.0.0", 15, "ipv4");
    v4.addSubnet("224.0.0.0", 4, "ipv4"); // 组播
    v4.addSubnet("240.0.0.0", 4, "ipv4"); // 保留
    const v6 = HostWhitelist.INTERNAL_IPV6;
    v6.addAddress("::1", "ipv6");
    v6.addAddress("::", "ipv6");
    v6.addSubnet("fc00::", 7, "ipv6"); // 唯一本地地址
    v6.addSubnet("fe80::", 10, "ipv6"); // 链路本地
  }

  /** 是否为内网/保留地址 */
  static isInternalIp(ip: string, family: "ipv4" | "ipv6"): boolean {
    const list = family === "ipv4" ? HostWhitelist.INTERNAL_IPV4 : HostWhitelist.INTERNAL_IPV6;
    if (list.check(ip, family)) {
      return true;
    }
    // IPv4-mapped IPv6（::ffff:10.1.2.3）按 IPv4 再判一次
    if (family === "ipv6") {
      const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
      if (mapped) {
        return HostWhitelist.INTERNAL_IPV4.check(mapped[1], "ipv4");
      }
    }
    return false;
  }

  /**
   * 判断目标主机是否允许访问
   * @param host 域名或IP
   */
  isAllowed(host?: string): boolean {
    const normalized = HostWhitelist.normalizeHost(host);
    if (!normalized) {
      return false;
    }
    const ipFamily = HostWhitelist.ipFamily(normalized);
    // 内网地址默认拒绝（SSRF防护），白名单里的 IP/CIDR 条目可显式放行
    if (ipFamily && HostWhitelist.isInternalIp(normalized, ipFamily)) {
      return this.blockList.check(normalized, ipFamily);
    }
    if (!this.enabled) {
      return true;
    }
    if (ipFamily) {
      // 目标是IP字面量，仅按 IP/CIDR 条目匹配
      return this.blockList.check(normalized, ipFamily);
    }
    if (this.domains.has(normalized)) {
      return true;
    }
    // 通配域名：匹配子域名，例如条目 *.example.com 允许 sub.example.com
    for (const suffix of this.wildcardDomains) {
      if (normalized.endsWith(`.${suffix}`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 校验目标主机，不在白名单内则抛出异常
   * @param host 域名或IP
   */
  assertAllowed(host?: string) {
    if (!this.isAllowed(host)) {
      throw new Error(`目标主机[${host}]不在站点监控白名单内，已拒绝访问（SSRF防护），如需监控请联系管理员将其加入白名单`);
    }
  }

  private static splitEntries(whitelist?: string | string[]): string[] {
    if (!whitelist) {
      return [];
    }
    const rawList = Array.isArray(whitelist) ? whitelist : whitelist.split(",");
    const entries: string[] = [];
    for (const item of rawList) {
      if (typeof item !== "string") {
        continue;
      }
      const entry = item.trim();
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }

  private addEntry(entry: string) {
    if (entry.startsWith("*.")) {
      // 通配域名
      const suffix = HostWhitelist.normalizeHost(entry.slice(2));
      if (suffix) {
        this.wildcardDomains.push(suffix);
      }
      return;
    }
    const cidrIndex = entry.indexOf("/");
    if (cidrIndex > 0) {
      // CIDR 网段
      const address = entry.slice(0, cidrIndex);
      const prefix = Number(entry.slice(cidrIndex + 1));
      const family = HostWhitelist.ipFamily(address);
      if (family && Number.isInteger(prefix)) {
        this.blockList.addSubnet(address, prefix, family);
      }
      // 非法CIDR条目直接忽略（不会意外放行任何目标）
      return;
    }
    const family = HostWhitelist.ipFamily(entry);
    if (family) {
      // 精确IP
      this.blockList.addAddress(entry, family);
      return;
    }
    // 其余按精确域名处理
    const domain = HostWhitelist.normalizeHost(entry);
    if (domain) {
      this.domains.add(domain);
    }
  }

  /**
   * 规范化主机名：去首尾空格、转小写、去掉末尾的根域名点
   */
  private static normalizeHost(host?: string): string {
    if (!host) {
      return "";
    }
    let normalized = host.trim().toLowerCase();
    if (normalized.endsWith(".")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  /**
   * 判断是否为IP字面量，返回 BlockList 所需的协议族，非IP返回 null
   */
  private static ipFamily(host: string): "ipv4" | "ipv6" | null {
    const version = net.isIP(host);
    if (version === 4) {
      return "ipv4";
    }
    if (version === 6) {
      return "ipv6";
    }
    return null;
  }
}
