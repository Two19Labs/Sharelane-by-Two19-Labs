#!/usr/bin/env node
// ShareLane ships its TypeScript source and runs it through tsx, registered
// in this process so `sharelane mcp` keeps a clean stdio channel.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
