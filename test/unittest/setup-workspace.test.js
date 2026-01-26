import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";

import { setupWorkspace } from "../../packages/runtime/dist/index.js";

test("setupWorkspace writes instruction files and additional files", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "uasdk-workspace-"));
  try {
    await setupWorkspace({
      cwd,
      instructions: "Hello from AGENTS.md",
      additionalFiles: {
        "notes.txt": "Extra notes",
        "nested/extra.md": "Nested extra",
      },
    });

    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "Hello from AGENTS.md");
    assert.equal(await readFile(join(cwd, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "Extra notes");
    assert.equal(await readFile(join(cwd, "nested/extra.md"), "utf8"), "Nested extra");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("setupWorkspace is idempotent", async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), "uasdk-workspace-idempotent-"));
  try {
    const opts = {
      cwd,
      instructions: "Hello again",
      additionalFiles: {
        "file.txt": "Payload",
      },
    };

    await setupWorkspace(opts);
    await setupWorkspace(opts);

    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "Hello again");
    assert.equal(await readFile(join(cwd, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "Payload");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
