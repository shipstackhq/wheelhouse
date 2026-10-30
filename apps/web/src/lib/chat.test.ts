import { describe, expect, test } from "vitest";
import type { ChatMessageView, ChatOptions } from "@wheelhouse/api-client";
import { activityLine, atBottom, chatPollInterval, deviceAvailability, endNote, joinMessage, liveLine, resolveNewChat, splitMessage, type NewChatForm } from "./chat";

const msg = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({ id: "m", seq: 1, role: "assistant", content: "", state: "done", error: null, activity: [], costUsd: null, createdAt: "2026-10-25T00:00:00.000Z", ...over });
const dev = (id: string, status: "online" | "offline", models: string[] = ["haiku", "sonnet"]) => ({ id, name: id, status, models });
const repo = (id: string) => ({ id, name: id, fullName: `o/${id}`, defaultBranch: "main" });
const form = (over: Partial<NewChatForm> = {}): NewChatForm => ({ teamKey: "AA", repositoryId: "", deviceId: "", model: "", message: "How does auth work?", ...over });
const options = (over: Partial<ChatOptions> = {}): ChatOptions => ({ devices: [dev("d1", "online")], repositories: [repo("r1"), repo("r2")], ...over });

describe("polling", () => {
  test("every 1.5 s while any answer is pending or streaming, otherwise never", () => {
    expect(chatPollInterval([msg({ role: "user" }), msg({ state: "pending" })])).toBe(1500);
    expect(chatPollInterval([msg({ state: "streaming" })])).toBe(1500);
    expect(chatPollInterval([msg(), msg({ state: "failed" }), msg({ state: "canceled" })])).toBe(false);
    expect(chatPollInterval(undefined)).toBe(false);
  });
});

describe("the live line", () => {
  test("shows the newest tool call as a phrase, and the tool's own name when it is not one we know", () => {
    expect(activityLine(msg({ activity: [{ name: "Grep", summary: "auth" }, { name: "Read", summary: "src/x.ts" }] }))).toBe("Reading src/x.ts");
    expect(activityLine(msg({ activity: [{ name: "Grep", summary: "auth" }] }))).toBe("Searching auth");
    expect(activityLine(msg({ activity: [{ name: "Other", summary: "" }] }))).toBe("Other");
    expect(activityLine(msg())).toBeNull();
  });
  test("only while the answer is going; before any activity it says what it is waiting for", () => {
    expect(liveLine(msg({ state: "pending" }))).toBe("Waiting for your device…");
    expect(liveLine(msg({ state: "streaming" }))).toBe("Thinking…");
    expect(liveLine(msg({ state: "streaming", activity: [{ name: "Read", summary: "a.ts" }] }))).toBe("Reading a.ts");
    expect(liveLine(msg({ state: "done", activity: [{ name: "Read", summary: "a.ts" }] }))).toBeNull();
  });
  test("a failed answer says its error, a stopped one says stopped, a good one says nothing", () => {
    expect(endNote(msg({ state: "failed", error: "Your device went quiet" }))).toBe("Your device went quiet");
    expect(endNote(msg({ state: "failed" }))).toBe("The answer failed.");
    expect(endNote(msg({ state: "canceled" }))).toBe("Stopped.");
    expect(endNote(msg())).toBeNull();
    expect(endNote(msg({ state: "streaming" }))).toBeNull();
  });
});

describe("which devices a chat can use", () => {
  test("only online ones that offer a model", () => {
    const r = deviceAvailability({ devices: [dev("a", "offline"), dev("b", "online"), dev("c", "online", [])] });
    expect(r.online.map((d) => d.id)).toEqual(["b"]);
    expect(r.reason).toBeNull();
  });
  test("when none can, the reason says why", () => {
    expect(deviceAvailability({ devices: [] }).reason).toMatch(/no paired device/);
    expect(deviceAvailability({ devices: [dev("a", "offline")] }).reason).toMatch(/online/);
    expect(deviceAvailability({ devices: [dev("a", "online", [])] }).reason).toMatch(/no models/);
  });
});

describe("the new chat form", () => {
  test("starts from the first device, repository and model on offer, and can be sent", () => {
    const r = resolveNewChat(form(), options());
    expect(r.form).toMatchObject({ deviceId: "d1", repositoryId: "r1", model: "haiku" });
    expect(r.problem).toBeNull();
  });
  test("keeps a pick that is still on offer and drops one that is not", () => {
    const o = options({ devices: [dev("d1", "offline"), dev("d2", "online", ["opus"])] });
    expect(resolveNewChat(form({ deviceId: "d1", repositoryId: "r2", model: "haiku" }), o).form).toMatchObject({ deviceId: "d2", repositoryId: "r2", model: "opus" });
    expect(resolveNewChat(form({ deviceId: "d2", model: "opus" }), o).form.model).toBe("opus");
  });
  test("says what stops it: no repository, no device, an empty or too long message", () => {
    expect(resolveNewChat(form(), options({ repositories: [] })).problem).toMatch(/no repository/);
    expect(resolveNewChat(form(), options({ devices: [dev("a", "offline")] })).problem).toMatch(/online/);
    expect(resolveNewChat(form({ message: "   " }), options()).problem).toBe("Write a message");
    expect(resolveNewChat(form({ message: "x".repeat(100_001) }), options()).problem).toMatch(/100000/);
    expect(resolveNewChat(form({ message: "x".repeat(100_000) }), options()).problem).toBeNull();
  });
  test("cannot be sent before the options have loaded", () => {
    expect(resolveNewChat(form(), undefined).problem).not.toBeNull();
  });
});

describe("following the text", () => {
  test("only when the view is at the bottom, give or take a few pixels", () => {
    expect(atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });
});

test("joinMessage and splitMessage: the typed text and pasted blocks survive the round trip", () => {
  const sent = joinMessage("  look at this ", ["log a\n\nmore", "log b"]);
  expect(sent).toBe("look at this\n\n<pasted>\nlog a\n\nmore\n</pasted>\n\n<pasted>\nlog b\n</pasted>");
  expect(splitMessage(sent)).toEqual({ text: "look at this", pastes: ["log a\n\nmore", "log b"] });
  expect(joinMessage(" ", [])).toBe("");
  expect(splitMessage("plain")).toEqual({ text: "plain", pastes: [] });
});
