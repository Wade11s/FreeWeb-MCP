#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logPath = join(dirname(fileURLToPath(import.meta.url)), "ego-events.jsonl");
const record = (event) => appendFileSync(logPath, `${JSON.stringify(event)}\n`);
let script = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { script += chunk; });
process.stdin.on("end", () => {
  const constant = (name) => {
    const match = script.match(new RegExp(`const ${name} = (\"(?:\\\\.|[^\"\\\\])*\");`));
    return match ? JSON.parse(match[1]) : undefined;
  };
  const marker = constant("RESULT_MARKER");
  if (!marker) throw new Error("Controlled ego script has no result marker");
  const name = constant("SPACE_NAME") ?? "controlled task";
  const taskIdText = /const TASK_ID = (null|-?\d+);/.exec(script)?.[1] ?? "7";
  const spaceId = taskIdText === "null" ? 7 : Number(taskIdText);
  const finish = script.includes("await task.finish({ keep:");
  const pages = ["p1"];

  if (finish) {
    record({ kind: "ego-finish", spaceId });
    process.stdout.write(`${marker}${JSON.stringify({
      ok: true,
      value: { finished: true },
      task: { spaceId, ownership: "user", name },
      pages,
      pageOrder: pages,
      receipt: { kept: pages, closed: [] },
      spaces: [{ id: spaceId, name, ownership: "user" }],
    })}\n`);
    return;
  }

  record({ kind: "ego-work", spaceId, created: taskIdText === "null" });
  for (const match of script.matchAll(/page\.goto\((\"(?:\\\\.|[^\"\\\\])*\")/g)) {
    record({ kind: "ego-navigation", spaceId, url: JSON.parse(match[1]) });
  }
  process.stdout.write(`${marker}${JSON.stringify({
    ok: true,
    value: taskIdText === "null" ? { opened: true } : { controlled: true },
    task: { spaceId, ownership: "agent", name },
    pages,
    pageOrder: pages,
    created: taskIdText === "null" ? true : undefined,
    spaces: [{ id: spaceId, name, ownership: "agent" }],
  })}\n`);
});
