// The images module's public surface: the only file another module may import. The Nest module class is not exported here; app.imports.ts imports it from images.module.
export { avatarUrl, workspaceImageUrl, parseUpload, sniffImageType } from "./images";
