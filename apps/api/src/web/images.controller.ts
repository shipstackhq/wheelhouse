import { Controller, Delete, Get, HttpCode, Param, Put, Req, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { readImageAs, setAvatarAs, setWorkspaceImageAs } from "../lib/images";
import { ServiceError } from "../common/service-error";
import type { RawTextRequest } from "../common/http/raw-text";
import { jsonBody } from "../common/body";
import { AppEndpoints } from "../common/decorators/app-endpoints.decorator";
import { SessionGuard, type SessionRequest } from "../common/guards/session.guard";

/** Custom pictures (WH-126). Uploads are `{ data }` in base64; the bytes go to whatever object storage the instance is set up with. */
@Controller("api/app")
@AppEndpoints()
@UseGuards(SessionGuard)
export class ImagesController {
  /** Your own profile picture. */
  @Put("me/avatar")
  setAvatar(@Req() req: SessionRequest & RawTextRequest) {
    return setAvatarAs(req.human, jsonBody(req).data);
  }

  @Delete("me/avatar")
  @HttpCode(200)
  removeAvatar(@Req() req: SessionRequest) {
    return setAvatarAs(req.human, null);
  }

  /** The workspace's image (owners and admins). */
  @Put("workspace/image")
  setWorkspaceImage(@Req() req: SessionRequest & RawTextRequest) {
    return setWorkspaceImageAs(req.human, jsonBody(req).data);
  }

  @Delete("workspace/image")
  @HttpCode(200)
  removeWorkspaceImage(@Req() req: SessionRequest) {
    return setWorkspaceImageAs(req.human, null);
  }

  /** The picture itself: `users/<id>` for someone in your workspace, `workspaces/<id>` for your own workspace. */
  @Get("images/:kind/:id")
  async image(@Req() req: SessionRequest, @Param("kind") kind: string, @Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    if (kind !== "users" && kind !== "workspaces") throw new ServiceError("not_found", "Image not found");
    const { body, contentType } = await readImageAs(req.human, kind, id);
    res.set({ "Content-Type": contentType, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
    return new StreamableFile(body);
  }
}
