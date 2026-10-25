import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

const HOUR_MS = 3_600_000;

/**
 * Removes trashed notifications for good once they are 30 days old: a few seconds after start, then every hour. Two processes running
 * it at once are safe (each row is deleted once). A failure is logged, never thrown. Not started under `node --test` (NODE_TEST_CONTEXT),
 * like the daemon sweep's timer it never fires during a test; tests call `NotificationsService.purge` directly.
 */
@Injectable()
export class NotificationsPurge implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("NotificationsPurge");
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(@Inject(NotificationsService) private readonly inbox: NotificationsService) {}

  onModuleInit() {
    if (process.env.NODE_TEST_CONTEXT) return;
    this.first = setTimeout(() => void this.run(), 5_000);
    this.timer = setInterval(() => void this.run(), HOUR_MS);
    this.first.unref();
    this.timer.unref();
  }

  async run() {
    try {
      const n = await this.inbox.purge();
      if (n) this.log.log(`purged ${n} notification(s) deleted over 30 days ago`);
    } catch (e) {
      this.log.warn(`purge failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  onApplicationShutdown() {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }
}
