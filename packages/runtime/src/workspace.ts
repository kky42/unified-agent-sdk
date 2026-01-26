import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type SetupWorkspaceOptions = {
  cwd: string;
  instructions: string;
  additionalFiles?: Record<string, string>;
};

const CLAUDE_INSTRUCTIONS_POINTER = "@AGENTS.md";

export async function setupWorkspace(opts: SetupWorkspaceOptions): Promise<void> {
  const { cwd, instructions, additionalFiles } = opts;
  const agentsPath = resolve(cwd, "AGENTS.md");
  const claudePath = resolve(cwd, "CLAUDE.md");

  const extraEntries = Object.entries(additionalFiles ?? {}).filter(([relativePath]) => {
    const resolved = resolve(cwd, relativePath);
    return resolved !== agentsPath && resolved !== claudePath;
  });

  await Promise.all([
    writeWorkspaceFile(agentsPath, instructions),
    writeWorkspaceFile(claudePath, `${CLAUDE_INSTRUCTIONS_POINTER}\n`),
    ...extraEntries.map(([relativePath, contents]) => writeWorkspaceFile(resolve(cwd, relativePath), contents)),
  ]);
}

async function writeWorkspaceFile(targetPath: string, contents: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents, "utf8");
}
