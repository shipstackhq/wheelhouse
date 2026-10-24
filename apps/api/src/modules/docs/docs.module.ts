import { Module } from "@nestjs/common";
import { DocsController } from "./docs.controller";
import { DocsService } from "./docs.service";

/** Workspace documentation: the person's side only (/api/app/teams/:key/docs), so it is part of the api role. */
@Module({ controllers: [DocsController], providers: [DocsService], exports: [DocsService] })
export class DocsModule {}
