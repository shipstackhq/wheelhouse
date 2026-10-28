// The actors module's public surface: the only file another module may import. The Nest module class is not exported here; importers take it from actors.module.
export { ActorsService, type ActorRef, type ActorAvatar, type ActorInput } from "./actors.service";
