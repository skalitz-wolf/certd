import { ALL, Body, Controller, Inject, Post, Provide } from "@midwayjs/core";
import { BaseController, CommonException, Constants, SysPrivateSettings, SysSettingsService } from "@certd/lib-server";
import jwt from "jsonwebtoken";
import { RedisExecReq, RedisToolService } from "../../../modules/sys/redistool/redistool-service.js";

@Provide()
@Controller("/api/sys/redistool")
export class SysRedisToolController extends BaseController {
  @Inject()
  redisToolService: RedisToolService;
  @Inject()
  sysSettingsService: SysSettingsService;

  @Post("/exec", { description: Constants.per.guest })
  async exec(@Body(ALL) body: RedisExecReq) {
    if (process.env.CERTD_REDISTOOL_ENABLED !== "true") {
      this.ctx.status = 404;
      return { code: 1, message: this.ctx.path + " Not Found" };
    }
    const token = (this.ctx.get("Authorization") || "").replace("Bearer ", "");
    let user: { roles?: number[] } | null = null;
    try {
      const setting = await this.sysSettingsService.getSetting<SysPrivateSettings>(SysPrivateSettings);
      user = jwt.verify(token, setting.jwtKey) as any;
    } catch (e) {
      user = null;
    }
    if (!user || !(user.roles ?? []).includes(1)) {
      throw new CommonException("forbidden");
    }
    const result = await this.redisToolService.exec(body);
    return this.ok(result);
  }
}
