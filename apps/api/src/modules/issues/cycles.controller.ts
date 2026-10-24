import { Controller, Inject, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { ServiceError } from "../../common/service-error";
import { IssuesService } from "./issues.service";
import type { RawTextRequest } from "../../common/http/raw-text";
import { jsonBody } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";

/** A cycle is addressed by its number inside the team. Anything that is not a whole number is a cycle that does not exist. */
const cycleNumber = (raw: string) => {
  if (!/^\d{1,9}$/.test(raw)) throw new ServiceError("not_found", `Cycle ${raw} not found`);
  return Number(raw);
};

/** A team's cycles (WH-117). A team of another workspace, or one the person is not on, is a 404; changing cycles needs an editor. */
@Controller("api/app/teams")
@AppEndpoints()
export class CyclesController {
  constructor(@Inject(IssuesService) private readonly issues: IssuesService) {}

  /** The cycles by when they are: `{ current, upcoming, past }`, each with how many issues are in it and how many are done. Ended cycles hand their unfinished issues on first. */
  @Get(":key/cycles")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.issues.listCyclesAs(req.human.actor, key);
  }

  /** `{ name?, goal?, startsAt?, endsAt? }`: from now for two weeks when the dates are left out; one to fourteen days, not overlapping another cycle of the team. */
  @Post(":key/cycles")
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { cycle: await this.issues.createCycleAs(req.human.actor, key, jsonBody(req)) };
  }

  /** One cycle: its issues, and what landed (reached Done) while it ran. */
  @Get(":key/cycles/:number")
  async one(@Req() req: SessionRequest, @Param("key") key: string, @Param("number") number: string) {
    return { cycle: await this.issues.getCycleAs(req.human.actor, key, cycleNumber(number)) };
  }

  /** `{ name?, goal?, startsAt?, endsAt? }`. A cycle that has ended keeps its dates. */
  @Patch(":key/cycles/:number")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("number") number: string) {
    return { cycle: await this.issues.updateCycleAs(req.human.actor, key, cycleNumber(number), jsonBody(req)) };
  }

  /** Its issues stay on the board, in no cycle. */
  @Delete(":key/cycles/:number")
  async remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("number") number: string) {
    return this.issues.deleteCycleAs(req.human.actor, key, cycleNumber(number));
  }
}
