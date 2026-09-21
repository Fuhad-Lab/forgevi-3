/**
 * THE PLATFORM LAW + THE CONTINUITY LAW — prompt contract tests.
 * Pure-function tests over buildTaskPrompt (no I/O).
 */
import { describe, expect, test } from "bun:test";
import { buildTaskPrompt, type ChatHistoryRow } from "../src/task.ts";

describe("buildTaskPrompt — THE PLATFORM LAW (Next.js mandate)", () => {
  test("carries the Next.js law, the HTML prohibition, and the dev-server law", () => {
    const prompt = buildTaskPrompt(
      { objective: "build a portfolio", acceptance: ["it works"], devPort: 4123, uploads: [] },
      [],
    );
    expect(prompt).toContain("NEXT.JS");
    expect(prompt).toContain("App Router");
    expect(prompt).toContain("NEVER deliver the app as a standalone .html document");
    expect(prompt).toContain("Keep the dev server RUNNING");
    expect(prompt).toContain("0.0.0.0");
    expect(prompt).toContain("curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:PORT");
    // THE DEV-PORT LINE: the run's assigned port rides the platform block
    expect(prompt).toContain("The dev-server port for this run is 4123");
    expect(prompt).toContain("The platform previews the app through that port");
  });

  test("an unassigned dev port omits the port line but keeps the platform laws", () => {
    const prompt = buildTaskPrompt(
      { objective: "x", acceptance: ["y"], devPort: null, uploads: [] },
      [],
    );
    expect(prompt).toContain("NEXT.JS");
    expect(prompt).not.toContain("The dev-server port for this run is");
  });
});

describe("buildTaskPrompt — THE CONTINUITY LAW (no new-conversation amnesia)", () => {
  const history: ChatHistoryRow[] = [
    { role: "user", content: "build me a blog" },
    { role: "assistant", content: "I built a Next.js blog with three posts." },
    { role: "user", content: "make the header sticky" },
    { role: "assistant", content: "The header is now sticky." },
  ];

  test("history rides the prompt with roles, and the continuation instruction is explicit", () => {
    const prompt = buildTaskPrompt(
      { objective: "add a dark mode", acceptance: ["dark mode works"], devPort: 4100, uploads: [] },
      history,
    );
    expect(prompt).toContain("[Conversation on this project so far]");
    expect(prompt).toContain("user: build me a blog");
    expect(prompt).toContain("assistant: I built a Next.js blog with three posts.");
    expect(prompt).toContain("CONTINUE from where the conversation left off");
    expect(prompt).toContain("Do NOT re-scaffold");
    // the new task rides AFTER the history
    expect(prompt.indexOf("user: make the header sticky")).toBeLessThan(prompt.indexOf("[New task]"));
  });

  test("empty history omits the conversation block entirely", () => {
    const prompt = buildTaskPrompt(
      { objective: "x", acceptance: ["y"], devPort: 1, uploads: [] },
      [],
    );
    expect(prompt).not.toContain("[Conversation on this project so far]");
  });

  test("acceptance rides as the definition of done", () => {
    const prompt = buildTaskPrompt(
      { objective: "x", acceptance: ["first", "second"], devPort: 1, uploads: [] },
      [],
    );
    expect(prompt).toContain("[Definition of done");
    expect(prompt).toContain("1. first");
    expect(prompt).toContain("2. second");
  });
});
