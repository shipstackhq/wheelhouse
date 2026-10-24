import { Module } from "@nestjs/common";
import { GithubModule } from "../github/github.module";
import { TeamsModule } from "../teams/teams.module";
import { MapController } from "./map.controller";
import { MapListeners } from "./map.listeners";
import { MapService } from "./map.service";

/** The knowledge map and what hangs off it: the person's side only (/api/app/teams/:key/map and its decisions, glossary and drafts), so it is part of the api role. */
@Module({ imports: [TeamsModule, GithubModule], controllers: [MapController], providers: [MapService, MapListeners], exports: [MapService] })
export class MapModule {}
