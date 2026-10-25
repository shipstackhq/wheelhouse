import { Module } from "@nestjs/common";
import { StreamController } from "./stream.controller";
import { StreamsModule } from "./streams.module";

/** The people's side of the streams (/api/stream, /api/teams/:key/stream), so part of the api role. The registry itself is StreamsModule, shared with the daemon's device streams. */
@Module({ imports: [StreamsModule], controllers: [StreamController] })
export class StreamApiModule {}
