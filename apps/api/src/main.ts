import "reflect-metadata";
import { configureEnvironment } from "./config";

configureEnvironment(); // before @wheelhouse/core is first used

const { NestFactory } = await import("@nestjs/core");
const { AppModule } = await import("./app.module");
const { rawText } = await import("./http/raw-text");
type App = import("@nestjs/platform-express").NestExpressApplication;

const app = await NestFactory.create<App>(AppModule, { bodyParser: false, logger: ["log", "warn", "error"] });
app.disable("x-powered-by");
app.use(rawText());
app.enableShutdownHooks(); // SIGTERM closes the database cleanly, which is what lets PGlite flush

const port = Number(process.env.PORT ?? 3000);
await app.listen(port, process.env.HOST ?? "0.0.0.0");
