import "reflect-metadata";
import { configureEnvironment } from "./config";

configureEnvironment(); // before the database or the libraries are first used

const { NestFactory } = await import("@nestjs/core");
const { AppModule } = await import("./app.module");
const { serveWebApp, webDistDir } = await import("./web-static");
type App = import("@nestjs/platform-express").NestExpressApplication;

const app = await NestFactory.create<App>(AppModule, { bodyParser: false, logger: ["log", "warn", "error"] });
app.disable("x-powered-by");
// The React app, when it has been built (the image has it; in development Vite serves it): same origin, one port.
const webDir = webDistDir();
if (webDir) app.use(serveWebApp(webDir));
app.enableShutdownHooks(); // SIGTERM closes the database cleanly, which is what lets PGlite flush
// A reverse proxy keeps connections to the app open between requests, and the server would wait for each one to time out
// (several seconds) before it let the process exit. Drop the idle ones at once and give requests in flight a moment to finish.
const server = app.getHttpServer();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen(port, process.env.HOST ?? "0.0.0.0");
