import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView, ChatOptions, ChatThreadView } from "@wheelhouse/api-client";
import { apiError, renderApp, type FakeServer } from "../test/harness";
import { FakeEventSource } from "../test/fake-event-source";

beforeEach(() => FakeEventSource.reset());
afterEach(() => vi.useRealTimers());

const thread = (over: Partial<ChatThreadView> = {}): ChatThreadView => ({
  id: "c1",
  title: "How does auth work?",
  teamKey: "AA",
  repositoryId: "r1",
  repositoryName: "wheelhouse",
  deviceId: "d1",
  deviceName: "MacBook",
  deviceStatus: "online",
  model: "haiku",
  running: false,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...over,
});
const message = (seq: number, over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: `m${seq}`,
  seq,
  role: seq % 2 ? "user" : "assistant",
  content: "",
  state: "done",
  error: null,
  activity: [],
  costUsd: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  ...over,
});
const options = (over: Partial<ChatOptions> = {}): ChatOptions => ({
  devices: [{ id: "d1", name: "MacBook", status: "online", models: ["haiku", "sonnet"] }],
  repositories: [{ id: "r1", name: "wheelhouse", fullName: "shipstackhq/wheelhouse", defaultBranch: "main" }],
  ...over,
});

/** A server holding one thread, answering the list and the thread from `state`. */
function serve(server: FakeServer, chat: ChatThreadView, messages: ChatMessageView[], opts = options()) {
  const state = { chat, messages };
  server.on("GET /api/app/chats", () => ({ chats: [state.chat] }));
  server.on("GET /api/app/chats/c1", () => ({ chat: state.chat, messages: state.messages }));
  server.on("GET /api/app/chats/options", opts);
  return state;
}

describe("a conversation", () => {
  test("shows both sides, the answer as markdown, and a failed answer plainly with its error", async () => {
    renderApp("/chat/c1", (s) => serve(s, thread(), [message(1, { content: "Explain auth" }), message(2, { content: "It uses **sessions**.", activity: [{ name: "Read", summary: "src/auth.ts" }] }), message(3, { content: "And then?" }), message(4, { state: "failed", error: "Your device went quiet" })]));
    const list = await screen.findByRole("list", { name: "Messages" });
    expect(within(list).getByText("Explain auth")).toBeTruthy();
    expect(within(list).getByText("sessions").tagName).toBe("STRONG");
    expect(within(list).getByRole("alert").textContent).toBe("Your device went quiet");
    expect(screen.queryByText("Reading src/auth.ts")).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false);
  });

  test("while an answer is running: the latest activity shows, the composer is off and Stop is offered; Stop asks the server to cancel", async () => {
    const { server } = renderApp("/chat/c1", (s) => {
      const state = serve(s, thread({ running: true }), [message(1, { content: "Explain auth" }), message(2, { state: "streaming", content: "It uses", activity: [{ name: "Grep", summary: "login" }, { name: "Read", summary: "src/x.ts" }] })]);
      s.on("POST /api/app/chats/c1/cancel", () => ({ chat: state.chat }));
    });
    expect((await screen.findByText("Reading src/x.ts")).getAttribute("role")).toBe("status");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(server.sent("POST /api/app/chats/c1/cancel")).toHaveLength(1));
  });

  test("a stopped answer says so", async () => {
    renderApp("/chat/c1", (s) => serve(s, thread(), [message(1, { content: "Q" }), message(2, { state: "canceled", content: "partial" })]));
    expect(await screen.findByText("Stopped.")).toBeTruthy();
    expect(screen.getByText("partial")).toBeTruthy();
  });

  test("reads the thread again every 1.5 s while an answer is going, and stops once it is done", async () => {
    const { server } = renderApp("/chat/c1", (s) => {
      const state = serve(s, thread({ running: true }), [message(1, { content: "Q" }), message(2, { state: "pending" })]);
      let reads = 0;
      s.on("GET /api/app/chats/c1", () => {
        if (++reads > 2) state.messages = [message(1, { content: "Q" }), message(2, { content: "Done now" })];
        return { chat: state.chat, messages: state.messages };
      });
    });
    expect(await screen.findByText("Waiting for your device…")).toBeTruthy();
    expect(await screen.findByText("Done now", {}, { timeout: 6000 })).toBeTruthy();
    const reads = server.sent("GET /api/app/chats/c1").length;
    await new Promise((r) => setTimeout(r, 2000));
    expect(server.sent("GET /api/app/chats/c1")).toHaveLength(reads);
  }, 15_000);

  test("Enter sends the follow-up, Shift+Enter does not", async () => {
    const { server } = renderApp("/chat/c1", (s) => {
      const state = serve(s, thread(), [message(1, { content: "Q" }), message(2, { content: "A" })]);
      s.on("POST /api/app/chats/c1/messages", () => {
        const added = [message(3, { content: "More" }), message(4, { state: "pending" })];
        state.messages = [...state.messages, ...added];
        return { messages: added };
      });
    });
    const box = await screen.findByLabelText("Message");
    await userEvent.type(box, "More{Shift>}{Enter}{/Shift}");
    expect(server.sent("POST /api/app/chats/c1/messages")).toHaveLength(0);
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/chats/c1/messages").map((c) => c.body)).toEqual([{ message: "More" }]));
    expect(await screen.findByText("Waiting for your device…")).toBeTruthy();
  });

  test("a follow-up can switch to another model the device offers; the same model is not sent", async () => {
    const { server } = renderApp("/chat/c1", (s) => {
      const state = serve(s, thread(), [message(1, { content: "Q" }), message(2, { content: "A" })]);
      s.on("POST /api/app/chats/c1/messages", () => {
        const added = [message(3, { content: "More" }), message(4, { state: "pending" })];
        state.messages = [...state.messages, ...added];
        return { messages: added };
      });
    });
    const picker = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() => expect(picker.textContent).toBe("haiku"));
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole("option", { name: "sonnet" }));
    await userEvent.type(screen.getByLabelText("Message"), "More{Enter}");
    await waitFor(() => expect(server.sent("POST /api/app/chats/c1/messages").map((c) => c.body)).toEqual([{ message: "More", model: "sonnet" }]));
  });

  test("a refusal while one is running (409) is shown", async () => {
    renderApp("/chat/c1", (s) => {
      serve(s, thread(), [message(1, { content: "Q" }), message(2, { content: "A" })]);
      s.on("POST /api/app/chats/c1/messages", () => apiError(409, "conflict", "An answer is already running"));
    });
    await userEvent.type(await screen.findByLabelText("Message"), "Hi{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/already running/);
  });

  test("an offline device turns the composer off and says why", async () => {
    renderApp("/chat/c1", (s) => serve(s, thread({ deviceStatus: "offline" }), [message(1, { content: "Q" }), message(2, { content: "A" })]));
    expect(await screen.findByText(/MacBook is offline/)).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
  });

  test("deleting asks first, then removes the thread and goes to the new chat page", async () => {
    const { server, at } = renderApp("/chat/c1", (s) => {
      serve(s, thread(), [message(1, { content: "Q" }), message(2, { content: "A" })]);
      s.on("DELETE /api/app/chats/c1", () => new Response(null, { status: 204 }));
    });
    await userEvent.click(await screen.findByRole("button", { name: "Delete chat" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(at()).toBe("/chat"));
    expect(server.sent("DELETE /api/app/chats/c1")).toHaveLength(1);
  });
});

describe("a new chat", () => {
  test("asks the first question with the first repository, online device and model, then opens the thread", async () => {
    const { server, at } = renderApp("/chat", (s) => {
      serve(s, thread(), [message(1, { content: "Explain auth" }), message(2, { state: "pending" })]);
      s.on("POST /api/app/chats", { chat: thread({ running: true }), messages: [message(1, { content: "Explain auth" }), message(2, { state: "pending" })] });
    });
    const box = await screen.findByLabelText("Ask about the code");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" }).textContent).toBe("haiku"));
    await userEvent.type(box, "Explain auth{Enter}");
    await waitFor(() => expect(at()).toBe("/chat/c1"));
    expect(server.sent("POST /api/app/chats").map((c) => c.body)).toEqual([{ teamKey: "AA", repositoryId: "r1", deviceId: "d1", model: "haiku", message: "Explain auth" }]);
  });

  test("with no device online it says why and cannot be sent", async () => {
    renderApp("/chat", (s) => serve(s, thread(), [], options({ devices: [{ id: "d1", name: "MacBook", status: "offline", models: ["haiku"] }] })));
    expect(await screen.findByText(/None of your devices is online/)).toBeTruthy();
    expect((screen.getByLabelText("Ask about the code") as HTMLTextAreaElement).disabled).toBe(true);
  });

  test("the sidebar links to it and lists the threads", async () => {
    renderApp("/chat", (s) => serve(s, thread(), []));
    const nav = await screen.findByRole("navigation", { name: "Chats" });
    expect(await within(nav).findByText("How does auth work?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Chat" }).getAttribute("href")).toBe("/w/ae/chat");
  });
});
