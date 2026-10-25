// The notifications module's public surface: the only file another module may import. Producers inject NotificationsService and list
// NotificationsCoreModule (the service without the routes, loaded by every role) in their imports.
export { NotificationsService } from "./notifications.service";
export { NotificationsCoreModule } from "./notifications.core.module";
export type { NotificationInput } from "./dto/notifications.dto";
