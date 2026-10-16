import { afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearOfflineData, InstallButton, PwaRegister } from "./pwa";

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "serviceWorker");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

const goOffline = (offline: boolean) => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: !offline });
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
};

/** A service worker container we can steer. */
function fakeServiceWorker() {
  const listeners = new Map<string, () => void>();
  const reg = { waiting: null as null | { postMessage: (m: string) => void }, installing: null as unknown, addEventListener: vi.fn(), active: { postMessage: vi.fn() } };
  const container = {
    controller: {},
    register: vi.fn(async () => reg),
    getRegistration: vi.fn(async () => reg),
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return { reg, container, listeners };
}

describe("the offline banner", () => {
  test("shows nothing while online, and says changes need a connection when offline", async () => {
    render(<PwaRegister />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => goOffline(true));
    expect((await screen.findByRole("status")).textContent).toBe("You're offline. Changes need a connection.");
    act(() => goOffline(false));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("starts out showing if the page loads offline", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<PwaRegister />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("registering the service worker", () => {
  test("not in development or tests: a worker there would serve stale files while you edit", () => {
    const sw = fakeServiceWorker();
    render(<PwaRegister />);
    expect(sw.container.register).not.toHaveBeenCalled();
  });

  test("in production it registers /sw.js for the whole site", () => {
    vi.stubEnv("PROD", true);
    const sw = fakeServiceWorker();
    render(<PwaRegister />);
    expect(sw.container.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  test("a new version waiting is offered, and agreeing tells it to take over", async () => {
    vi.stubEnv("PROD", true);
    const sw = fakeServiceWorker();
    const waiting = { postMessage: vi.fn() };
    sw.reg.waiting = waiting;
    render(<PwaRegister />);
    const user = userEvent.setup();
    expect(await screen.findByText("A new version is available.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reload to update" }));
    expect(waiting.postMessage).toHaveBeenCalledWith("SKIP_WAITING");
  });

  test("a first install (no controller yet) does not nag about an update", async () => {
    vi.stubEnv("PROD", true);
    const sw = fakeServiceWorker();
    sw.container.controller = null as unknown as object;
    sw.reg.waiting = { postMessage: vi.fn() };
    render(<PwaRegister />);
    await act(async () => {});
    expect(screen.queryByText("A new version is available.")).toBeNull();
  });
});

describe("wiping what is stored before sign-out", () => {
  test("tells the active worker to clear its caches", async () => {
    const sw = fakeServiceWorker();
    await clearOfflineData();
    expect(sw.reg.active.postMessage).toHaveBeenCalledWith("CLEAR_CACHES");
  });
  test("is harmless where there are no service workers", async () => {
    await expect(clearOfflineData()).resolves.toBeUndefined();
  });
});

describe("installing", () => {
  test("the button appears only when the browser offers installation, and then prompts", async () => {
    render(<InstallButton />);
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
    render(<PwaRegister />);
    const prompt = vi.fn(async () => {});
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt });
    act(() => void window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); // we keep the prompt for our own button
    const button = await screen.findByRole("button", { name: "Install app" });
    await userEvent.setup().click(button);
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
  });
});
