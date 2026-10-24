import type { Actor } from "../../common/actor";
import * as ini from "./initiatives";

/**
 * What the web app's Initiatives pages read and write (WH-119), as functions of the signed-in person. Every answer is already
 * limited to what that person may see: projects of teams they are not on appear only as totals, and a guest sees no initiatives.
 */

type Body = Record<string, unknown>;

export const listInitiativesAs = (actor: Actor) => ini.listInitiatives(actor);
export const getInitiativeAs = (actor: Actor, id: string) => ini.getInitiative(actor, id);
export const createInitiativeAs = (actor: Actor, b: Body) => ini.createInitiative(actor, b);
export const updateInitiativeAs = (actor: Actor, id: string, b: Body) => ini.updateInitiative(actor, id, b);
export const deleteInitiativeAs = (actor: Actor, id: string) => ini.deleteInitiative(actor, id);
export const linkProjectAs = (actor: Actor, id: string, b: Body) => ini.linkProject(actor, id, b.projectId);
export const unlinkProjectAs = (actor: Actor, id: string, projectId: string) => ini.unlinkProject(actor, id, projectId);
