import { z } from "zod";
import { anything, stringOrUndefined, text, textOrNull, textOrUndefined } from "../../../common/pipes/lenient";

/** `{ name, key?, description?, parent? }`. The service judges the values; the key defaults from the name. */
export const createTeamDto = z.object({ name: text, key: textOrUndefined, description: text, parent: textOrNull });
export type CreateTeamDto = z.infer<typeof createTeamDto>;

/** `{ name?, description?, icon?, iconColor? }`. `icon` and `iconColor` are judged by the service (`null` clears them). */
export const updateTeamDto = z.object({ name: stringOrUndefined, description: stringOrUndefined, icon: anything, iconColor: anything });
export type UpdateTeamDto = z.infer<typeof updateTeamDto>;

/** `{ parent }`: a team key, or nothing to make the team top-level. */
export const setParentDto = z.object({ parent: textOrNull });
export type SetParentDto = z.infer<typeof setParentDto>;

/** `{ keys }`: the order this person keeps their teams in; the service checks it. */
export const setOrderDto = z.object({ keys: anything });
export type SetOrderDto = z.infer<typeof setOrderDto>;

/** `{ userId, role }`: add a member. */
export const addMemberDto = z.object({ userId: text, role: anything });
export type AddMemberDto = z.infer<typeof addMemberDto>;

/** `{ role }`: change a member's role. */
export const setMemberRoleDto = z.object({ role: anything });
export type SetMemberRoleDto = z.infer<typeof setMemberRoleDto>;

/** The status routes pass the whole body on; the service reads the fields it knows (name, role, color, isDefault) and judges them. */
export const statusBodyDto = z.looseObject({});
export type StatusBodyDto = z.infer<typeof statusBodyDto>;

/** `{ ids }`: the new order of a team's statuses; the service checks it. */
export const reorderStatusesDto = z.object({ ids: anything });
export type ReorderStatusesDto = z.infer<typeof reorderStatusesDto>;
