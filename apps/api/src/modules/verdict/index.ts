// The verdict module's public surface: the only file another module may import.
export { VerdictModule } from "./verdict.module";
export { VerdictService, type PullRequestHead } from "./verdict.service";
export type { Verdict, VerdictState } from "./verdict.rules";
