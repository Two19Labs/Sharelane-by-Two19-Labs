#!/usr/bin/env node
// ShareLane ships its TypeScript source and runs it through tsx, registered
// in this process so `sharelane mcp` keeps a clean stdio channel.

// Checked before anything loads: older Node fails later on node:sqlite with a
// confusing error. Imports below are dynamic so this runs first.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `ShareLane needs Node.js 24 or newer, but this is Node ${process.versions.node}.\n` +
      "Install the current LTS from https://nodejs.org, open a new terminal, and try again.",
  );
  process.exit(1);
}

const { register } = await import("tsx/esm/api");
register();
await import("../src/cli.ts");
