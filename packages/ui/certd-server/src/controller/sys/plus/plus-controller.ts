import { ALL, Body, Controller, Inject, Post, Provide } from "@midwayjs/core";
import { BaseController, PlusService, SysInstallInfo, SysLicenseInfo, SysSettingsService } from "@certd/lib-server";
import { logger } from "@certd/basic";

/**
 * 本地试用时长（天）。
 * 官方试用为 7 天，这里可通过环境变量 CERTD_LOCAL_TRIAL_DAYS 覆盖。
 */
const LOCAL_TRIAL_DAYS = Number(process.env.CERTD_LOCAL_TRIAL_DAYS || 365000);

/**
 */
@Provide()
@Controller("/api/sys/plus")
export class SysPlusController extends BaseController {
  @Inject()
  sysSettingsService: SysSettingsService;

  @Inject()
  plusService: PlusService;

  @Post("/active", { description: "sys:settings:edit" })
  async active(@Body(ALL) body) {
    const { code, inviteCode } = body;

    await this.plusService.active(code, inviteCode);

    return this.ok(true);
  }
  @Post("/bindUrl", { description: "sys:settings:edit" })
  async bindUrl(@Body(ALL) body: { url: string; url2?: string }) {
    const { url, url2 } = body;
    await this.plusService.register();
    const installInfo: SysInstallInfo = await this.sysSettingsService.getSetting(SysInstallInfo);
    await this.plusService.bindUrl(url, url2);
    installInfo.bindUrl = url;
    installInfo.bindUrl2 = url2;
    await this.sysSettingsService.saveSetting(installInfo);

    //重新验证vip
    try {
      await this.plusService.verify();
    } catch (e) {
      logger.error(`验证配置失败:${e}`);
    }

    return this.ok(true);
  }

  /**
   * 本地试用。
   *
   * 官方试用需要 certd 服务器访问远程 plus 服务器（api.handfree.work），出方向网络不通时无法领取。
   * 这里直接构造一个本地 license，仅做本地校验激活，不走远程接口。
   *
   * 依赖 @certd/plus-core 的验签补丁（放行 signature 为 "local-trial" 的 license），
   * 补丁位于 packages/ui/patch/plus-core/index.js，由 packages/ui/Dockerfile 覆盖进镜像。
   */
  @Post("/getVipTrial", { description: "sys:settings:edit" })
  async getVipTrial(@Body("vipType") vipType = "plus") {
    const now = Date.now();
    const licenseContent = {
      code: "local-trial",
      // secret 不能为空：plus-core 的定时检查发现 isPlus 且无 secret 会直接退出进程
      secret: "local-trial",
      vipType,
      activeTime: now,
      duration: LOCAL_TRIAL_DAYS,
      expireTime: now + LOCAL_TRIAL_DAYS * 24 * 60 * 60 * 1000,
      version: 1,
      signature: "local-trial",
    };
    const license = Buffer.from(JSON.stringify(licenseContent)).toString("base64");

    // 持久化 license，服务重启后由 AutoInitSite 读取并重新本地校验
    let licenseInfo: SysLicenseInfo = await this.sysSettingsService.getSetting(SysLicenseInfo);
    if (!licenseInfo) {
      licenseInfo = new SysLicenseInfo();
    }
    licenseInfo.license = license;
    await this.sysSettingsService.saveSetting(licenseInfo);

    // verifyLocalOnly 只做本地验签（依赖上面的补丁），不请求远程服务器
    const plusRequestService = await this.plusService.getPlusRequestService();
    const res = await plusRequestService.verifyLocalOnly({ license });
    if (!res?.isPlus) {
      throw new Error("本地试用license校验失败：请确认plus-core验签补丁已生效");
    }
    return this.ok({ duration: LOCAL_TRIAL_DAYS });
  }
  @Post("/getTodayVipOrderCount", { description: "sys:settings:edit" })
  async getTodayVipOrderCount() {
    const res = await this.plusService.getTodayOrderCount();
    return this.ok(res);
  }
  //
  // @Get('/test', { description: Constants.per.guest })
  // async test() {
  //   const subjectId = 'xxxxxx';
  //   const license = '';
  //   const timestamps = 1728365013899;
  //   const bindUrl = 'http://127.0.0.1:7001/';
  //   const service = new PlusRequestService({
  //     subjectId: subjectId,
  //     plusServerBaseUrls: ['https://api.ai.handfree.work'],
  //   });
  //   const body = { subjectId, appKey: 'kQth6FHM71IPV3qdWc', url: bindUrl };
  //
  //   async function test() {
  //     await verify({
  //       subjectId: subjectId,
  //       license: license,
  //       plusRequestService: service,
  //     });
  //
  //     const res = await service.sign(body, timestamps);
  //     console.log('sign:', res);
  //
  //     const res2 = await service.request({
  //       url: '/activation/subject/vip/check',
  //       data: {
  //         url: 'http://127.0.0.1:7001/',
  //       },
  //     });
  //
  //     console.log('res2:', res2);
  //   }
  //   console.log('2222');
  //   await test();
  //   console.log('3333');
  //
  //   return this.ok(true);
  // }
}
