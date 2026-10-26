/**
 * PFX 证书转换参数的命令注入防护
 *
 * 漏洞背景：`@certd/plugin-lib` 的 `CertConverter.convertPfx` 把 pfxArgs 和 pfxPassword
 * 直接拼进一条 openssl 命令字符串，再交给 `sp.spawn({ shell: true })` 执行：
 *
 *   `openssl pkcs12 ${pfxArgs} -export -out ${pfxPath} -inkey ${tmpKeyPath} -in ${tmpCrtPath} ${passwordArg}`
 *
 * 而 pfxArgs / pfxPassword 都是 @TaskInput，任何能建流水线的用户都能填，
 * 一个 `;` 或 `|` 就是 RCE（和 lego 插件同类的漏洞）。
 *
 * 为什么在这里拦截而不是改 CertConverter：
 * `@certd/plugin-lib` 属于 packages/plugins，镜像构建时从 npm 解析，
 * 改它的源码不会进入镜像（见 docs/adr/0002）。因此只能在 certd-server 侧、
 * 调用 CertConverter 之前校验。
 */

/**
 * pfxArgs 允许的字符集：字母数字 + 空格 + 参数符号（-、_、=、:、.、,、/）。
 * pfxArgs 是 openssl 的参数串，正常取值形如
 * `-macalg SHA1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES`，不需要引号和 %。
 */
const PFX_ARGS_SAFE_CHARS = /^[A-Za-z0-9 _\-=:.,/]+$/;

/**
 * pfxPassword 禁止的字符：shell 元字符和换行。
 *
 * 这里用黑名单而不是白名单，因为 pfxPassword 是用户自定的证书导出密码，
 * 合法值可能包含 !@#$%^&* 等符号，白名单会误伤存量密码。
 * 拦掉的这些字符在 shell 里可直接断开命令或触发替换。
 */
const PFX_PASSWORD_UNSAFE = /[;|&`$()<>\r\n]/;

/**
 * 校验 PFX 转换参数，校验失败抛异常，命令不会执行。
 * @param pfxArgs PFX 转换参数（openssl 参数串）
 * @param pfxPassword 证书加密密码
 */
export function assertSafePfxConvert(pfxArgs: string | undefined, pfxPassword: string | undefined) {
  if (pfxArgs != null && pfxArgs !== "") {
    if (!PFX_ARGS_SAFE_CHARS.test(pfxArgs)) {
      throw new Error("PFX证书转换参数包含不允许的字符，仅允许字母、数字、空格及 - _ = : . , /");
    }
  }
  if (pfxPassword != null && pfxPassword !== "") {
    if (PFX_PASSWORD_UNSAFE.test(pfxPassword)) {
      throw new Error("证书加密密码不能包含 ; | & ` $ ( ) < > 和换行符");
    }
  }
}
