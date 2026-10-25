import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { Database } from "../../platform/database/database";
import { TeamsModule } from "../teams/teams.module";
import { AdminController } from "./workspaces/admin.controller";
import { AuthController } from "./auth.controller";
import { AuthRepository } from "./auth.repository";
import { bindAuthLegacy } from "./auth.legacy";
import { InvitesController } from "./invites/invites.controller";
import { InvitesService } from "./invites/invites.service";
import { KeysController } from "./keys/keys.controller";
import { KeysService } from "./keys/keys.service";
import { MeController } from "./me.controller";
import { SessionsService } from "./sessions.service";
import { WorkspaceController } from "./workspaces/workspace.controller";
import { WorkspacesService } from "./workspaces/workspaces.service";

/** Sign-in, the person's workspaces, members, invites, API keys and the instance admin pages: the person's side only, so it is part of the api role. */
@Module({
  imports: [TeamsModule],
  controllers: [AuthController, MeController, WorkspaceController, InvitesController, KeysController, AdminController],
  providers: [AuthRepository, SessionsService, KeysService, InvitesService, WorkspacesService],
})
export class AuthModule implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(KeysService) private readonly keys: KeysService,
    @Inject(InvitesService) private readonly invites: InvitesService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  /** Points the legacy functions (auth.legacy.ts) at the live services. */
  onModuleInit() {
    bindAuthLegacy({ db: this.db, sessions: this.sessions, keys: this.keys, invites: this.invites, workspaces: this.workspaces });
  }
}
