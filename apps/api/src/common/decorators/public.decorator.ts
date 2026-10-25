import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "wheelhouse:public";

/**
 * An /api/app route that does not need a signed-in person (sign in, sign up, an invite link). Every other route of a controller
 * with @AppEndpoints() requires a session: the default is closed, and a route is opened only by saying so here.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
