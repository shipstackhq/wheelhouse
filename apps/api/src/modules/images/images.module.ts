import { Module } from "@nestjs/common";
import { ImagesController } from "./images.controller";

/** Custom pictures (the person's side only, /api/app), so part of the api role. The functions are plain (images.ts); the controller is the only Nest piece. */
@Module({ controllers: [ImagesController] })
export class ImagesModule {}
