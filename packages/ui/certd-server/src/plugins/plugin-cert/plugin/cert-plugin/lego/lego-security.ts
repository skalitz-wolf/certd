/**
 * lego 证书申请插件命令注入防护
 *
 * 漏洞背景：lego 插件的命令行是通过字符串拼接后交给 shell 执行的
 * （childProcess.spawn(cmd, { shell: true })），用户可控的输入（customArgs、
 * customCommandOptions、dnsType、email、domains、acmeServer、EAB 等）一旦包含
 * 分号、管道、美元符等 shell 元字符，即可注入任意命令并回显结果（RCE）。
 *
 * 修复方式：对用户可控字段做严格校验：
 * 1. 结构化字段（email/dnsType/domains/privateKeyType/acmeServer/EAB）使用白名单正则；
 * 2. 自定义参数（customArgs/customCommandOptions）使用字符白名单，
 *    排除所有可能被 shell 解释的元字符，仅保留 lego 命令行参数的常用字符。
 *
 * 校验失败时抛出异常，命令不会执行。
 */

/** 自定义参数允许的字符集：字母数字 + 常见参数符号（-、_、=、:、.、,、/、引号、@、%、+、空格） */
const LEGO_ARG_SAFE_CHARS = /^[A-Za-z0-9 _\-=:.,/'"@%+]+$/;

/** 邮箱格式 */
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** DNS 提供商类型：仅字母数字下划线中划线 */
const DNS_TYPE_REGEX = /^[A-Za-z0-9_-]+$/;

/** 域名（含泛域名 *. 前缀，也兼容纯 IP 形式的证书域名） */
const DOMAIN_REGEX = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** 加密算法白名单，与 lego 插件 a-select 的选项一致 */
const PRIVATE_KEY_TYPES = new Set(["rsa2048", "rsa3072", "rsa4096", "rsa8192", "ec256", "ec384", "ec_521"]);

/** EAB kid/hmacKey：base64 及常见安全字符 */
const EAB_CHARS = /^[A-Za-z0-9+/=._-]+$/;

function assertTrue(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 校验自定义 lego 命令行参数，禁止 shell 元字符
 * @param value 参数原文
 * @param fieldName 字段名（用于错误提示）
 */
export function assertSafeLegoArg(value: string | undefined, fieldName: string) {
  if (!value) {
    return;
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`${fieldName}不能包含换行符`);
  }
  assertTrue(LEGO_ARG_SAFE_CHARS.test(value), `${fieldName}包含不允许的字符，仅允许字母、数字及 - _ = : . , / ' " @ % + 和空格，禁止 ; | & \` $ ( ) < > * ? { } 等特殊字符`);
}

/**
 * 校验邮箱
 */
export function assertValidLegoEmail(email: string | undefined) {
  assertTrue(!!email && EMAIL_REGEX.test(email), "邮箱格式不正确，且不能包含特殊字符");
}

/**
 * 校验 DNS 提供商类型
 */
export function assertValidLegoDnsType(dnsType: string | undefined) {
  assertTrue(!!dnsType && DNS_TYPE_REGEX.test(dnsType), "DNS类型格式不正确，仅允许字母、数字、下划线和中划线");
}

/**
 * 校验证书域名（含泛域名和IP形式）
 */
export function assertValidLegoDomain(domain: string | undefined) {
  assertTrue(!!domain && DOMAIN_REGEX.test(domain), `证书域名[${domain}]格式不正确，仅允许域名、泛域名(*.example.com)或IP`);
}

/**
 * 校验加密算法类型
 */
export function assertValidLegoPrivateKeyType(privateKeyType: string | undefined) {
  assertTrue(!!privateKeyType && PRIVATE_KEY_TYPES.has(privateKeyType), `加密算法[${privateKeyType}]不在允许范围内`);
}

/**
 * 校验 ACME 服务地址：必须是合法的 https URL，且不含 shell 特殊字符
 */
export function assertValidLegoAcmeServer(acmeServer: string | undefined) {
  if (!acmeServer) {
    return;
  }
  let url: URL;
  try {
    url = new URL(acmeServer);
  } catch (e) {
    throw new Error(`ACME服务地址[${acmeServer}]格式不正确，必须是以 https:// 开头的合法地址`);
  }
  assertTrue(url.protocol === "https:", `ACME服务地址[${acmeServer}]必须使用 https 协议`);
  assertTrue(!/[\r\n;|&`$()<>]/.test(acmeServer), "ACME服务地址包含不允许的特殊字符");
}

/**
 * 校验 EAB 授权凭证（kid/hmacKey）
 */
export function assertValidLegoEab(kid: string | undefined, hmacKey: string | undefined) {
  if (!kid && !hmacKey) {
    return;
  }
  assertTrue(!!kid && EAB_CHARS.test(kid), "EAB的kid格式不正确，包含不允许的字符");
  assertTrue(!!hmacKey && EAB_CHARS.test(hmacKey), "EAB的hmacKey格式不正确，包含不允许的字符");
}
