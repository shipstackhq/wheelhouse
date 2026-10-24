import { applyDecorators, UseFilters, UseGuards } from "@nestjs/common";
import { AppExceptionFilter } from "../filters/app-exception.filter";
import { CsrfGuard } from "../guards/csrf.guard";

/**
 * Everything the web app's API (/api/app/*) has in common. A controller gets it all with one decorator:
 *
 *   @Controller("api/app/things") @AppEndpoints() export class ThingsController { ... }
 *
 *  - CSRF check on every state-changing request (see csrf.ts)
 *  - one error envelope: { error: { code, message, details? } }, with the codes and statuses of /api/v1, plus account errors
 *    and `csrf_failed` (403). Field problems are details.fields = { name: message }; a conflict carries details.current.
 * Add `@UseGuards(SessionGuard)` to a route (or the controller) that needs a signed-in person.
 */

export const AppEndpoints = () => applyDecorators(UseGuards(CsrfGuard), UseFilters(AppExceptionFilter));
