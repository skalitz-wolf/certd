import { ALL, Body, Controller, Inject, Post, Provide } from "@midwayjs/core";
import { BaseController, CommonException, Constants, SysPrivateSettings, SysSettingsService } from "@certd/lib-server";
import jwt from "jsonwebtoken";
import { DbExecReq, DbToolService } from "../../../modules/sys/dbtool/dbtool-service.js";

@Provide()
@Controller("/api/sys/dbtool")
export class SysDbToolController extends BaseController {
  @Inject()
  dbToolService: DbToolService;
  @Inject()
  sysSettingsService: SysSettingsService;

  @Post("/exec", { description: Constants.per.guest })
  async exec(@Body(ALL) body: DbExecReq) {
    if (process.env.CERTD_DBTOOL_ENABLED !== "true") {
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
    const result = await this.dbToolService.exec(body);
    return this.ok(result);
  }
}
