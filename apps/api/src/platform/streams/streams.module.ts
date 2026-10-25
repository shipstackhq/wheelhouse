import { Module } from "@nestjs/common";
import { StreamRegistry } from "./stream.registry";

/** The open-streams registry, one instance for every module that serves a stream (people's and devices'), so a shutdown ends them all. */
@Module({ providers: [StreamRegistry], exports: [StreamRegistry] })
export class StreamsModule {}
