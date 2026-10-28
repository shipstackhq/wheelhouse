import { Module } from "@nestjs/common";
import { ActorsService } from "./actors.service";

/** Resolves "who is this" (a person or an agent) into one `ActorRef` with a picture. No controllers: other modules' presenters use the service. */
@Module({ providers: [ActorsService], exports: [ActorsService] })
export class ActorsModule {}
