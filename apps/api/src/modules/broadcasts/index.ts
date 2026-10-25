// The broadcasts module's public surface: the only file another module may import. The Nest module class is imported from its own
// file (broadcasts.module) by the module that lists it.
export { BroadcastsService } from "./broadcasts.service";
export type { BroadcastInput, BroadcastAudience } from "./dto/broadcasts.dto";
