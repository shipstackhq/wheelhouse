import type { Actor } from "../../common/actor";
import * as cy from "./cycles";

/**
 * What the web app's Cycles pages read and write (WH-117), as functions of the signed-in person. The team is found inside the
 * person's own workspace and they must be on it, so another workspace's team, or a cycle number it does not have, is "not found".
 */

type Body = Record<string, unknown>;

const fields = (b: Body): cy.CycleInput => ({ name: b.name as string | undefined, goal: b.goal as string | undefined, startsAt: b.startsAt, endsAt: b.endsAt });

export const listCyclesAs = (actor: Actor, teamKey: string) => cy.listCycles(actor, teamKey);
export const getCycleAs = (actor: Actor, teamKey: string, number: number) => cy.getCycle(actor, teamKey, number);
export const createCycleAs = (actor: Actor, teamKey: string, b: Body) => cy.createCycle(actor, teamKey, fields(b));
export const updateCycleAs = (actor: Actor, teamKey: string, number: number, b: Body) => cy.updateCycle(actor, teamKey, number, fields(b));
export const deleteCycleAs = (actor: Actor, teamKey: string, number: number) => cy.deleteCycle(actor, teamKey, number);
