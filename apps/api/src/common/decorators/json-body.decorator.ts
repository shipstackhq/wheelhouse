import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "../body";

/**
 * The JSON object in the request body, as `@JsonBody(new ZodValidationPipe(schema)) dto: Dto`. The app reads bodies as raw text
 * (common/http/raw-text.ts) so that authentication is judged before the body is; this decorator parses it at the handler, with the same
 * 400 for a body that is not a JSON object, and the pipe then shapes it into the route's DTO.
 */
export const JsonBody = createParamDecorator((_data: unknown, ctx: ExecutionContext): Record<string, unknown> => jsonBody(ctx.switchToHttp().getRequest<RawTextRequest>()));
