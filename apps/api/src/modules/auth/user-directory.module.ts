import { Module } from "@nestjs/common";
import { UserDirectory } from "./user-directory";

/** The directory without the auth module's routes, for the modules that only need to list people. */
@Module({ providers: [UserDirectory], exports: [UserDirectory] })
export class UserDirectoryModule {}
