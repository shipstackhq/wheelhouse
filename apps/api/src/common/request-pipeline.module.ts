import { Injectable, Module, type MiddlewareConsumer, type NestMiddleware, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { ServiceErrorFilter } from "./filters/service-error.filter";
import { rawText } from "./http/raw-text";

const readBody = rawText();

/** Request bodies are read as text and parsed by each handler (`@JsonBody`), so authentication can fail before a body is judged. */
@Injectable()
export class RawTextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    readBody(req, res, next);
  }
}

/**
 * What every request goes through, declared once: the raw-text body reader for every route, and a ServiceError filter for any
 * controller that has no filter of its own (a controller's own filter, such as the app's or the daemon's, still comes first).
 * The per-area pieces stay with their area: @AppEndpoints() (CSRF, session, the app envelope), the v1 and MCP filters, the device
 * guard.
 */
@Module({ providers: [{ provide: APP_FILTER, useClass: ServiceErrorFilter }] })
export class RequestPipelineModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RawTextMiddleware).forRoutes("*");
  }
}
