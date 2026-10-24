import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { InvitesController } from "./invites.controller";
import { KeysController } from "./keys.controller";
import { MeController } from "./me.controller";
import { WorkspaceController } from "./workspace.controller";

/** Sign-in, the person's workspaces, members, invites, API keys and the instance admin pages: the person's side only, so it is part of the api role. */
@Module({ controllers: [AuthController, MeController, WorkspaceController, InvitesController, KeysController, AdminController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
