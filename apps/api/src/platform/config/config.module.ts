import { Global, Module } from "@nestjs/common";
import { AppConfig } from "./app-config";

/** Global, so any module can inject AppConfig without importing this module. */
@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
