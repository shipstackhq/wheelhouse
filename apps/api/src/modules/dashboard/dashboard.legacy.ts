import type { BriefingService } from "./briefing.service";

/**
 * Temporary. The MCP tools (through lib/tools.ts) and the tests still call the briefing as plain functions; these are those functions,
 * each one line forwarding to the live service. `DashboardModule.onModuleInit` points them at the service Nest built, so nothing works
 * before the application has booted (tests call `testApp()`). Delete this file when the tests move to the service.
 */
let live: BriefingService | undefined;

export function bindDashboardLegacy(briefing: BriefingService) {
  live = briefing;
}
const s = (): BriefingService => live ?? (() => { throw new Error("The dashboard module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

export const briefing = (...a: Parameters<BriefingService["briefing"]>) => s().briefing(...a);
export const issueContext = (...a: Parameters<BriefingService["issueContext"]>) => s().issueContext(...a);
