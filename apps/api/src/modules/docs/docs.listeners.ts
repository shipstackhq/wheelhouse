import { Inject, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { CHANGES_REPORTED, FILES_LANDED, SESSION_SYNCED, type ChangesReported, type FilesLanded, type SessionSynced } from "../map/index";
import { DocFreshnessService } from "./doc-freshness.service";

/**
 * What the docs module does when the map says something happened (map.events.ts). `suppressErrors: false` so a failure here fails the
 * map call that emitted the event, as a direct call would have (the default logs the error and goes on). The first two answer the map
 * with what they did to the docs.
 */
@Injectable()
export class DocsListeners {
  constructor(@Inject(DocFreshnessService) private readonly freshness: DocFreshnessService) {}

  /** Files were reported changed: the docs anchored to them are flagged stale. */
  @OnEvent(CHANGES_REPORTED, { suppressErrors: false })
  onChangesReported(e: ChangesReported) {
    return this.freshness.changesReported(e);
  }

  /** Files landed on the default branch: the docs anchored to them publish their drafts or record or flag drift. */
  @OnEvent(FILES_LANDED, { suppressErrors: false })
  onFilesLanded(e: FilesLanded) {
    return this.freshness.filesLanded(e);
  }

  /** A work session reported its files: doc drafts it no longer has in flux are discarded. */
  @OnEvent(SESSION_SYNCED, { suppressErrors: false })
  onSessionSynced(e: SessionSynced) {
    return this.freshness.sessionSynced(e);
  }
}
