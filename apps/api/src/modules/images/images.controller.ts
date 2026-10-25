import { Controller, Delete, Get, HttpCode, Param, Put, Req, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { readImageAs, setAvatarAs, setWorkspaceImageAs } from "./images";
import { ServiceError } from "../../common/service-error";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { imageDto, type ImageDto } from "./dto/images.dto";

/** Custom pictures (WH-126). Uploads are `{ data }` in base64; the bytes go to whatever object storage the instance is set up with. */
@Controller("api/app")
@AppEndpoints()
export class ImagesController {
  /** Your own profile picture. */
  @Put("me/avatar")
  setAvatar(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(imageDto)) body: ImageDto) {
    return setAvatarAs(req.human, body.data);
  }

  @Delete("me/avatar")
  @HttpCode(200)
  removeAvatar(@Req() req: SessionRequest) {
    return setAvatarAs(req.human, null);
  }

  /** The workspace's image (owners and admins). */
  @Put("workspace/image")
  setWorkspaceImage(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(imageDto)) body: ImageDto) {
    return setWorkspaceImageAs(req.human, body.data);
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
