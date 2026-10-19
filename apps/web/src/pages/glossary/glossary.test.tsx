import { describe, expect, test } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { graph, MAP_TERMS } from "../../test/data";
import { FakeEventSource } from "../../test/fake-event-source";

const open = (setup: Parameters<typeof renderApp>[1] = () => {}, path = "/p/AA/glossary") => renderApp(path, setup);
const cards = () => within(screen.getByRole("list")).getAllByRole("link");
/** One term's own page (t1 is Invoice, t2 is Tenant). */
const detail = async (id: "t1" | "t2", setup: Parameters<typeof renderApp>[1] = () => {}) => {
  const app = open(setup, `/p/AA/glossary/${id}`);
  await screen.findByRole("heading", { level: 1, name: id === "t1" ? "Invoice" : "Tenant" });
  return app;
};

describe("the glossary home", () => {
  test("is a grid of cards, each a link to its term showing the term and the concept it names, not the definition", async () => {
    open();
    await screen.findByRole("heading", { name: "Glossary" });
    expect(screen.getByRole("list").className).toContain("lg:grid-cols-3");
    const links = cards();
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/p/AA/glossary/t1", "/p/AA/glossary/t2"]);
    const invoice = screen.getByRole("link", { name: /^Invoice/ });
    expect(within(invoice).getByText("Billing")).toBeTruthy(); // the concept, as a label (the card is the link)
    expect(within(screen.getByRole("link", { name: /^Tenant/ })).queryByText("Billing")).toBeNull();
    expect(screen.queryByText("A bill we send")).toBeNull();
  });

  test("with no terms it says so; the filter matches the term or its definition, and says when nothing matches", async () => {
    const { unmount } = open((s) => s.on("GET /api/app/projects/AA/graph", graph("AA", { terms: [] })));
    await screen.findByText("No terms yet.");
    unmount();
    open();
    await screen.findByRole("heading", { name: "Glossary" });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Filter…"), "workspace");
    expect(screen.queryByText("Invoice")).toBeNull();
    expect(screen.getByText("Tenant")).toBeTruthy();
    await user.clear(screen.getByPlaceholderText("Filter…"));
    await user.type(screen.getByPlaceholderText("Filter…"), "INVOICE");
    expect(screen.getByText("Invoice")).toBeTruthy();
    await user.clear(screen.getByPlaceholderText("Filter…"));
    await user.type(screen.getByPlaceholderText("Filter…"), "zzz");
    expect(screen.getByText("No terms match.")).toBeTruthy();
  });

  test("clicking a card opens that term at its own address", async () => {
    const { at } = open();
    await userEvent.setup().click(await screen.findByRole("link", { name: /^Invoice/ }));
    await waitFor(() => expect(at()).toBe("/p/AA/glossary/t1"));
    expect(await screen.findByText("A bill we send")).toBeTruthy();
  });

  test("+ Add term opens a form that needs a term and a definition, and saves them with the chosen concept", async () => {
    const { server } = open((s) => s.on("PUT /api/app/projects/AA/terms/Runbook", { term: { id: "t9", term: "Runbook", definition: "Steps to follow", nodeId: null } }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add term" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText("Term"), "  Runbook ");
    expect(save.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/^Definition/), "Steps to follow");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/terms/Runbook")).toHaveLength(1));
    expect(server.sent("PUT /api/app/projects/AA/terms/Runbook")[0].body).toEqual({ definition: "Steps to follow", node: null });
    expect(server.sent("PUT /api/app/projects/AA/terms/Runbook")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    await waitFor(() => expect(screen.queryByPlaceholderText("Term")).toBeNull()); // closed
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/graph").length).toBeGreaterThan(1)); // read again
  });

  test("a term with a slash or spaces in its name is sent correctly in the path", async () => {
    const { server } = open((s) => s.on("PUT /api/app/projects/AA/terms/CI%2FCD%20pipeline", { term: MAP_TERMS[0] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add term" }));
    await user.type(screen.getByPlaceholderText("Term"), "CI/CD pipeline");
    await user.type(screen.getByPlaceholderText(/^Definition/), "How code ships");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/terms/CI%2FCD%20pipeline")).toHaveLength(1));
  });

  test("a refusal is shown in the form, in the server's words, and what was typed is kept", async () => {
    open((s) => s.on("PUT /api/app/projects/AA/terms/Bad", apiError(404, "not_found", 'Node "x" not found')));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add term" }));
    await user.type(screen.getByPlaceholderText("Term"), "Bad");
    await user.type(screen.getByPlaceholderText(/^Definition/), "Whatever");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Node "x" not found')).toBeTruthy();
    expect((screen.getByPlaceholderText("Term") as HTMLInputElement).value).toBe("Bad");
  });

  test("the concept list offers only concept nodes", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add term" }));
    await user.click(screen.getByRole("combobox"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["No concept node", "Billing"]);
  });

  test("a term added by someone else appears over the live stream", async () => {
    let terms = [...MAP_TERMS];
    open((s) => s.on("GET /api/app/projects/AA/graph", () => graph("AA", { terms })));
    await screen.findByRole("link", { name: /^Invoice/ });
    await waitFor(() => expect(FakeEventSource.open.length).toBe(1));
    terms = [...terms, { id: "t3", term: "Runbook", definition: "Steps", nodeId: null }];
    act(() => FakeEventSource.open[0].emit("change", { seq: 5 }));
    await screen.findByRole("link", { name: /^Runbook/ });
  });
});

describe("one term", () => {
  test("shows the term, the definition and a link to the concept it names; a term with none has no link", async () => {
    await detail("t1");
    expect(screen.getByText("A bill we send")).toBeTruthy();
    const article = screen.getByRole("article");
    expect(within(article).getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/p/AA/map?node=c-bill");
    expect(within(screen.getByRole("navigation", { name: "Glossary navigation" })).getByRole("link", { name: /Glossary/ }).getAttribute("href")).toBe("/p/AA/glossary");
  });

  test("a term without a concept has no concept link", async () => {
    await detail("t2");
    expect(within(screen.getByRole("article")).queryByRole("link")).toBeNull();
  });

  test("an id that is not a term says so", async () => {
    open(() => {}, "/p/AA/glossary/nope");
    expect(await screen.findByText("This term is not in the glossary.")).toBeTruthy();
  });

  test("Edit changes the definition in place; Cancel puts it back", async () => {
    const { server } = await detail("t1", (s) => s.on("PUT /api/app/projects/AA/terms/Invoice", { term: MAP_TERMS[0] }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const def = screen.getByPlaceholderText(/^Definition/) as HTMLTextAreaElement;
    expect(def.value).toBe("A bill we send");
    expect((screen.getByPlaceholderText("Term") as HTMLInputElement).value).toBe("Invoice");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Term")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const again = screen.getByPlaceholderText(/^Definition/);
    await user.clear(again);
    await user.type(again, "A bill");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/terms/Invoice")).toHaveLength(1));
    expect(server.sent("PUT /api/app/projects/AA/terms/Invoice")[0].body).toEqual({ definition: "A bill", node: "c-bill" });
    expect(server.sent("DELETE /api/app/projects/AA/terms/t1")).toHaveLength(0); // same name: no delete
  });

  test("renaming a term removes the old name and defines the new one (terms are keyed by name), then leaves the old address", async () => {
    const { server, at } = await detail("t2", (s) => {
      s.on("DELETE /api/app/projects/AA/terms/t2", { ok: true });
      s.on("PUT /api/app/projects/AA/terms/Customer", { term: MAP_TERMS[1] });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByPlaceholderText("Term");
    await user.clear(name);
    await user.type(name, "Customer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PUT /api/app/projects/AA/terms/Customer")).toHaveLength(1));
    expect(server.sent("DELETE /api/app/projects/AA/terms/t2")).toHaveLength(1);
    expect(server.requests.indexOf("DELETE /api/app/projects/AA/terms/t2")).toBeLessThan(server.requests.indexOf("PUT /api/app/projects/AA/terms/Customer"));
    await waitFor(() => expect(at()).toBe("/p/AA/glossary"));
  });

  test("Remove asks first: Cancel does nothing, Remove deletes by id and returns to the glossary", async () => {
    const { server, at } = await detail("t1", (s) => s.on("DELETE /api/app/projects/AA/terms/t1", { ok: true }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Remove “Invoice”?")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent("DELETE /api/app/projects/AA/terms/t1")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/projects/AA/terms/t1")).toHaveLength(1));
    await waitFor(() => expect(at()).toBe("/p/AA/glossary"));
  });
});
