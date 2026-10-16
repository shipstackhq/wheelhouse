import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./fonts.css";
import "./app.css";
import { createServices, ServicesProvider } from "./lib/services";
import { buildRoutes } from "./routes/router";

// The router needs the services (route guards read the cache) and the services need the router (a session that ends sends
// you to /login), so the second is wired up after both exist.
// eslint-disable-next-line prefer-const -- assigned below, used in the callback
let router: ReturnType<typeof createBrowserRouter>;
const services = createServices({ onSignedOut: () => void router.navigate("/login", { replace: true }) });
router = createBrowserRouter(buildRoutes(services));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>
  </StrictMode>,
);
