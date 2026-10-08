// ShareLane office: agents are employees on a small pixel-art floor. Where an
// employee stands shows what its agent is doing; clicking one opens a panel to
// read its conversation and live output, and to pause, resume, stop, reply to,
// or assign work. The art is drawn in code (no image files), and every text
// goes in through text nodes, never markup.

const T = 16; // tile size in world pixels
const COLS = 30;
const ROWS = 18;
const WORLD_W = COLS * T;
const WORLD_H = ROWS * T;
const RECENT_MS = 6 * 60 * 60 * 1000;
const SPEED = 3.2; // tiles per second
const WORLD_SCALE = 2; // canvas pixels per world pixel
const SPRITE_SCALE = 3; // people and chairs are drawn bigger, like a game sprite

const C = {
  wood: "#c79f68", woodAlt: "#bd9560", plank: "#a9804f",
  carpet: "#6f8fa8", carpetAlt: "#67869d", rug: "#c86b5a", rugEdge: "#e6c27a",
  tile: "#dcd6c8", tileAlt: "#cfc8b8",
  wallTop: "#463a57", wallFace: "#e9dfcf", wallTrim: "#8c79a3", wallShadow: "#cdbfab",
  window: "#a6d8f2", windowShine: "#e6f6ff", frame: "#5b4a6e",
  desk: "#7f5235", deskTop: "#a8704a", deskEdge: "#6a432b",
  screenOff: "#2e3442", bezel: "#1c202b", screenOn: "#163a33", code: "#6ff0b0", codeAlt: "#e8f2ff",
  chair: "#38486a", chairDark: "#2a3752",
  leaf: "#4f9e4a", leafDark: "#367236", pot: "#b5643c", potDark: "#8d4a2b",
  sofa: "#b9525c", sofaDark: "#8f3b45", cushion: "#d36d74",
  table: "#80553a", tableTop: "#a06c48",
  board: "#c99a5b", boardFrame: "#7a5434", paper: "#f6f0e2", pin: "#d9453d",
  rack: "#303542", rackDark: "#22262f", led: "#6ef08a", ledAlt: "#f0c84a",
  mailbox: "#3e6fb0", mailDark: "#2c5288", letter: "#fff8e8",
  shadow: "rgba(20, 16, 30, 0.28)", ink: "#1b1b24",
  coffee: "#4b4f5c", steam: "rgba(255,255,255,0.65)",
};

const looks = {
  claude: { shirt: "#d97757", shirtDark: "#b85d40", hair: "#5a3825", skin: "#f1c7a0", pants: "#3a3f55" },
  codex: { shirt: "#3f9e8f", shirtDark: "#2e7a6e", hair: "#1f1f26", skin: "#c68b5e", pants: "#2f3445" },
  antigravity: { shirt: "#5b7cfa", shirtDark: "#4560cf", hair: "#e3bf55", skin: "#f5d3b3", pants: "#3b3550" },
};
const spareLooks = [
  { shirt: "#b26fd6", shirtDark: "#8e52ad", hair: "#2b2230", skin: "#e9b996", pants: "#34354a" },
  { shirt: "#e0b84a", shirtDark: "#b8952f", hair: "#7a3b22", skin: "#f3cfae", pants: "#373b4f" },
  { shirt: "#5aa0d8", shirtDark: "#3f7fb3", hair: "#c9c9d1", skin: "#d9a07a", pants: "#2d3142" },
];

// ---------- the floor plan ----------
const deskSlots = [[2, 4], [6, 4], [10, 4], [14, 4], [2, 9], [6, 9], [10, 9], [14, 9]];
const reviewSpots = [[3, 14], [4, 14], [5, 14], [6, 14]];
const meetingSpots = [[22, 11], [24, 11], [26, 11], [22, 14], [24, 14], [26, 14]];
const sofaSpots = [[21, 4], [22, 4], [23, 4]];
const lounge = { x1: 20, y1: 5, x2: 28, y2: 8 };
const door = [14, 16];

const blocked = new Set();
const key = (x, y) => `${x},${y}`;
const block = (x, y) => blocked.add(key(x, y));
for (let x = 0; x < COLS; x += 1) { block(x, 0); block(x, 1); block(x, ROWS - 1); }
for (let y = 0; y < ROWS; y += 1) { block(0, y); block(COLS - 1, y); }
for (let y = 2; y < ROWS - 1; y += 1) if (y !== 6 && y !== 13) block(19, y);
for (let x = 20; x < COLS - 1; x += 1) if (x !== 24) block(x, 9);
for (const [x, y] of deskSlots) for (let dx = 0; dx < 3; dx += 1) block(x + dx, y);
for (let x = 3; x <= 6; x += 1) block(x, 13); // review board
for (let x = 9; x <= 11; x += 1) block(x, 13); // your desk
block(17, 12); block(17, 13); // server rack
block(16, 16); // mailbox
for (let x = 21; x <= 23; x += 1) block(x, 3); // sofa
block(27, 2); block(28, 2); // coffee machine and counter
block(25, 2); block(26, 2); // bookshelf
for (let x = 22; x <= 26; x += 1) { block(x, 12); block(x, 13); } // meeting table
for (const [x, y] of [[1, 2], [18, 2], [1, 16], [28, 8], [20, 16], [28, 16], [18, 16]]) block(x, y); // plants

const walkable = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked.has(key(x, y));

function findPath(from, to) {
  const start = key(from[0], from[1]);
  const goal = key(to[0], to[1]);
  if (start === goal) return [];
  const previous = new Map([[start, null]]);
  const queue = [from];
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (previous.has(k) || (!walkable(nx, ny) && k !== goal)) continue;
      previous.set(k, key(x, y));
      if (k === goal) {
        const path = [];
        for (let at = goal; at && at !== start; at = previous.get(at)) path.unshift(at.split(",").map(Number));
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return [to];
}

// ---------- what each employee is doing ----------
const modes = {
  work: { bubble: "…", tone: "active", label: "Working" },
  queued: { bubble: "…", tone: "active", label: "Starting" },
  paused: { bubble: "Zz", tone: "warning", label: "Paused" },
  needs: { bubble: "!", tone: "critical", label: "Needs you" },
  review: { bubble: "✓", tone: "good", label: "Ready for review" },
  tired: { bubble: "Zz", tone: "serious", label: "Out of allowance" },
  idle: { bubble: "", tone: "", label: "Free" },
};

const recent = (iso) => iso && Date.now() - Date.parse(iso) < RECENT_MS;

function agentTasks(state, name) {
  return state.tasks.filter((task) => task.agent === name);
}

/** Pick the task that best explains what an agent is doing right now. */
function primaryTask(state, name) {
  const tasks = agentTasks(state, name);
  return (
    tasks.find((task) => task.status === "running") ??
    tasks.find((task) => task.status === "queued") ??
    tasks.find((task) => task.status === "paused") ??
    tasks.find((task) => ["needs_reassignment", "failed", "orphaned"].includes(task.status) && recent(task.updatedAt)) ??
    tasks.find((task) => task.status === "completed" && task.changedFiles.length && recent(task.finishedAt ?? task.updatedAt)) ??
    tasks[0]
  );
}

function modeFor(agent, task) {
  if (task?.status === "running") return "work";
  if (task?.status === "queued") return "queued";
  if (task?.status === "paused") return "paused";
  if (task && ["needs_reassignment", "failed", "orphaned"].includes(task.status) && recent(task.updatedAt)) return "needs";
  if (task?.status === "completed" && task.changedFiles.length && recent(task.finishedAt ?? task.updatedAt)) return "review";
  if (agent.quota.state === "handoff") return "tired";
  return "idle";
}

function statusLine(mode, task) {
  const short = task?.title && task.title.length > 60 ? `${task.title.slice(0, 59)}…` : task?.title;
  const title = short ? `“${short}”` : "";
  switch (mode) {
    case "work": return `Working on ${title}`;
    case "queued": return `Getting ready for ${title}`;
    case "paused": return `Paused on ${title}. The work so far is saved on its branch.`;
    case "needs": return task.status === "needs_reassignment"
      ? `Ran out of allowance on ${title} and needs someone to take over.`
      : `Hit a problem on ${title}.`;
    case "review": return `Finished ${title}. Its branch is ready for you to review.`;
    case "tired": return "Out of allowance for now, so resting until it resets.";
    default: return "Free. Give me a task.";
  }
}

// ---------- drawing ----------
function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

function drawFloor(ctx) {
  for (let y = 2; y < ROWS - 1; y += 1) {
    for (let x = 1; x < COLS - 1; x += 1) {
      const px = x * T;
      const py = y * T;
      if (x < 19) {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.wood : C.woodAlt);
        rect(ctx, px, py + 7, T, 1, C.plank);
        rect(ctx, px + ((y % 2) ? 4 : 11), py, 1, 7, C.plank);
        rect(ctx, px + ((y % 2) ? 12 : 3), py + 8, 1, 8, C.plank);
      } else if (y < 9) {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.carpet : C.carpetAlt);
      } else {
        rect(ctx, px, py, T, T, (x + y) % 2 ? C.tile : C.tileAlt);
        rect(ctx, px, py + 15, T, 1, C.tileAlt);
        rect(ctx, px + 15, py, 1, T, C.tileAlt);
      }
    }
  }
  // Lounge rug.
  rect(ctx, 21 * T, 5 * T + 4, 6 * T, 3 * T - 6, C.rugEdge);
  rect(ctx, 21 * T + 2, 5 * T + 6, 6 * T - 4, 3 * T - 10, C.rug);
  // Doorway mat.
  rect(ctx, door[0] * T - 4, 16 * T + 6, 2 * T + 8, 10, "#6b4f3a");
}

function drawWalls(ctx) {
  rect(ctx, 0, 0, WORLD_W, T, C.wallTop);
  rect(ctx, 0, T, WORLD_W, T, C.wallFace);
  rect(ctx, 0, 2 * T - 2, WORLD_W, 2, C.wallShadow);
  rect(ctx, 0, T, WORLD_W, 2, C.wallTrim);
  for (let x = 2; x < COLS - 2; x += 4) {
    if (x > 24) continue;
    const px = x * T + 2;
    rect(ctx, px, T + 3, 2 * T - 4, 10, C.frame);
    rect(ctx, px + 2, T + 5, 2 * T - 8, 6, C.window);
    rect(ctx, px + 4, T + 5, 3, 6, C.windowShine);
    rect(ctx, px + T - 2, T + 3, 1, 10, C.frame);
  }
  rect(ctx, 0, 0, T / 2, WORLD_H, C.wallTop);
  rect(ctx, WORLD_W - T / 2, 0, T / 2, WORLD_H, C.wallTop);
  rect(ctx, 0, WORLD_H - T / 2, WORLD_W, T / 2, C.wallTop);
  // Front door gap.
  rect(ctx, door[0] * T, WORLD_H - T / 2, 2 * T, T / 2, "#7a5434");
  // Inner walls with doorways.
  for (let y = 2; y < ROWS - 1; y += 1) {
    if (y === 6 || y === 13) continue;
    rect(ctx, 19 * T + 5, y * T, 6, T, C.wallTop);
    rect(ctx, 19 * T + 11, y * T, 1, T, C.wallTrim);
  }
  for (let x = 20; x < COLS - 1; x += 1) {
    if (x === 24) continue;
    rect(ctx, x * T, 9 * T + 4, T, 6, C.wallTop);
    rect(ctx, x * T, 9 * T + 10, T, 2, C.wallTrim);
  }
}

function drawPlant(ctx, x, y) {
  const px = x * T;
  const py = y * T;
  rect(ctx, px + 4, py + 10, 8, 6, C.pot);
  rect(ctx, px + 4, py + 14, 8, 2, C.potDark);
  rect(ctx, px + 3, py + 2, 10, 9, C.leaf);
  rect(ctx, px + 1, py + 5, 4, 4, C.leaf);
  rect(ctx, px + 11, py + 4, 4, 5, C.leaf);
  rect(ctx, px + 6, py, 4, 4, C.leaf);
  rect(ctx, px + 5, py + 5, 2, 4, C.leafDark);
  rect(ctx, px + 9, py + 3, 2, 3, C.leafDark);
}

function drawDesk(ctx, slot, screen, frame) {
  const [x, y] = slot;
  const px = x * T;
  const py = y * T;
  rect(ctx, px + 1, py + 15, 3 * T - 2, 2, C.shadow);
  rect(ctx, px, py + 3, 3 * T, 9, C.deskTop);
  rect(ctx, px, py + 12, 3 * T, 4, C.desk);
  rect(ctx, px, py + 3, 3 * T, 1, C.deskEdge);
  // Monitor.
  const mx = px + 15;
  rect(ctx, mx, py - 7, 18, 12, C.bezel);
  rect(ctx, mx + 7, py + 5, 4, 2, C.bezel);
  const sx = mx + 1;
  const sy = py - 6;
  if (screen === "on") {
    rect(ctx, sx, sy, 16, 10, C.screenOn);
    for (let line = 0; line < 4; line += 1) {
      const width = 3 + ((line * 5 + Math.floor(frame / 6)) % 10);
      rect(ctx, sx + 2, sy + 1 + line * 2 + 1, width, 1, line % 2 ? C.codeAlt : C.code);
    }
  } else if (screen === "paused") {
    rect(ctx, sx, sy, 16, 10, "#3d3a2a");
    rect(ctx, sx + 5, sy + 2, 2, 6, C.ledAlt);
    rect(ctx, sx + 9, sy + 2, 2, 6, C.ledAlt);
  } else if (screen === "alert") {
    rect(ctx, sx, sy, 16, 10, "#4a2026");
    rect(ctx, sx + 7, sy + 2, 2, 4, "#ff6b6b");
    rect(ctx, sx + 7, sy + 7, 2, 1, "#ff6b6b");
  } else {
    rect(ctx, sx, sy, 16, 10, C.screenOff);
    rect(ctx, sx + 2, sy + 1, 3, 1, "#3f4758");
  }
  // Keyboard, mug, papers.
  rect(ctx, px + 16, py + 7, 16, 3, "#e6e2da");
  rect(ctx, px + 16, py + 9, 16, 1, "#b9b4aa");
  rect(ctx, px + 39, py + 5, 4, 4, "#f2f2f2");
  rect(ctx, px + 43, py + 6, 1, 2, "#f2f2f2");
  rect(ctx, px + 3, py + 5, 8, 6, C.paper);
  rect(ctx, px + 4, py + 7, 5, 1, "#c9c2b0");
}

function drawChair(ctx, x, y) {
  const px = x * T;
  const py = y * T;
  rect(ctx, px + 3, py + 4, 10, 8, C.chair);
  rect(ctx, px + 4, py + 12, 2, 3, C.chairDark);
  rect(ctx, px + 10, py + 12, 2, 3, C.chairDark);
}

function drawChairBack(ctx, px, py) {
  rect(ctx, px + 2, py + 13, 12, 3, C.chair);
  rect(ctx, px + 2, py + 13, 12, 1, "#4b5d82");
}

/** Draw a 16x16 sprite at SPRITE_SCALE, its bottom centre on the bottom centre of tile (tileX, tileY). */
function withSprite(ctx, tileX, tileY, draw) {
  const footX = Math.round((tileX * T + T / 2) * WORLD_SCALE);
  const footY = Math.round((tileY * T + T) * WORLD_SCALE);
  ctx.setTransform(SPRITE_SCALE, 0, 0, SPRITE_SCALE, footX - 8 * SPRITE_SCALE, footY - 16 * SPRITE_SCALE);
  draw();
  ctx.setTransform(WORLD_SCALE, 0, 0, WORLD_SCALE, 0, 0);
}

function drawFurniture(ctx, frame, deskScreens, mail) {
  // Lounge.
  rect(ctx, 21 * T, 3 * T - 2, 3 * T, 4, C.sofaDark);
  rect(ctx, 21 * T, 3 * T + 2, 3 * T, 12, C.sofa);
  rect(ctx, 21 * T + 2, 3 * T + 4, T - 3, 7, C.cushion);
  rect(ctx, 22 * T + 1, 3 * T + 4, T - 2, 7, C.cushion);
  rect(ctx, 23 * T + 1, 3 * T + 4, T - 3, 7, C.cushion);
  rect(ctx, 21 * T - 2, 3 * T, 3, 14, C.sofaDark);
  rect(ctx, 24 * T - 1, 3 * T, 3, 14, C.sofaDark);
  // Bookshelf.
  rect(ctx, 25 * T, 2 * T - 6, 2 * T, T + 6, C.desk);
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const sy = 2 * T - 4 + shelf * 6;
    rect(ctx, 25 * T + 2, sy, 2 * T - 4, 1, C.deskEdge);
    ["#d9453d", "#5b7cfa", "#e3bf55", "#3f9e8f", "#b26fd6"].forEach((color, index) =>
      rect(ctx, 25 * T + 3 + index * 5, sy - 4, 3, 4, color));
  }
  // Coffee counter.
  rect(ctx, 27 * T, 2 * T + 2, 2 * T - 2, 12, C.tableTop);
  rect(ctx, 27 * T, 2 * T + 12, 2 * T - 2, 4, C.table);
  rect(ctx, 27 * T + 3, 2 * T - 6, 10, 10, C.coffee);
  rect(ctx, 27 * T + 5, 2 * T - 4, 6, 3, "#8fd3ff");
  rect(ctx, 28 * T + 2, 2 * T, 4, 4, "#f2f2f2");
  if (frame % 40 < 20) rect(ctx, 28 * T + 3, 2 * T - 4, 1, 3, C.steam);
  else rect(ctx, 28 * T + 4, 2 * T - 5, 1, 3, C.steam);
  // Meeting table.
  rect(ctx, 22 * T, 12 * T + 15, 5 * T, 2, C.shadow);
  rect(ctx, 22 * T, 12 * T, 5 * T, 2 * T - 1, C.tableTop);
  rect(ctx, 22 * T, 13 * T + 10, 5 * T, 5, C.table);
  rect(ctx, 23 * T, 12 * T + 5, 10, 7, C.paper);
  rect(ctx, 25 * T + 4, 12 * T + 8, 8, 6, C.paper);
  // Review board.
  rect(ctx, 3 * T, 13 * T - 10, 4 * T, 22, C.boardFrame);
  rect(ctx, 3 * T + 2, 13 * T - 8, 4 * T - 4, 18, C.board);
  for (let note = 0; note < 6; note += 1) {
    const nx = 3 * T + 5 + note * 10;
    const ny = 13 * T - 6 + (note % 2) * 7;
    rect(ctx, nx, ny, 7, 6, note % 3 === 0 ? "#fff2a8" : C.paper);
    rect(ctx, nx + 3, ny, 1, 1, C.pin);
  }
  rect(ctx, 3 * T + 4, 13 * T + 12, 3, 4, C.boardFrame);
  rect(ctx, 7 * T - 7, 13 * T + 12, 3, 4, C.boardFrame);
  // Your desk.
  rect(ctx, 9 * T, 13 * T + 15, 3 * T, 2, C.shadow);
  rect(ctx, 9 * T, 13 * T, 3 * T, 11, "#5d3a6e");
  rect(ctx, 9 * T, 13 * T + 11, 3 * T, 5, "#432a50");
  rect(ctx, 9 * T + 6, 13 * T + 2, 12, 7, C.paper);
  rect(ctx, 10 * T + 6, 13 * T - 6, 16, 11, C.bezel);
  rect(ctx, 10 * T + 7, 13 * T - 5, 14, 8, "#2f5d8a");
  rect(ctx, 11 * T + 5, 13 * T + 3, 6, 5, "#e3bf55");
  drawChair(ctx, 10, 14);
  // Server rack where checks run.
  rect(ctx, 17 * T, 12 * T - 6, T, 2 * T + 6, C.rack);
  for (let row = 0; row < 5; row += 1) {
    rect(ctx, 17 * T + 2, 12 * T - 3 + row * 7, T - 4, 5, C.rackDark);
    rect(ctx, 17 * T + 4, 12 * T - 2 + row * 7, 2, 2, (frame + row * 7) % 30 < 15 ? C.led : C.ledAlt);
  }
  // Mailbox: notices waiting for an agent.
  rect(ctx, 16 * T + 3, 16 * T - 2, 10, 10, C.mailbox);
  rect(ctx, 16 * T + 3, 16 * T - 2, 10, 2, C.mailDark);
  rect(ctx, 16 * T + 7, 16 * T + 8, 2, 7, C.mailDark);
  if (mail > 0) {
    rect(ctx, 16 * T + 5, 16 * T - 5, 6, 4, C.letter);
    rect(ctx, 16 * T + 12, 16 * T - 6, 3, 6, C.pin);
  }
  // Desks for each agent.
  deskScreens.forEach((screen, index) => {
    drawDesk(ctx, deskSlots[index], screen, frame);
  });
  for (const plant of [[1, 2], [18, 2], [1, 16], [28, 8], [20, 16], [28, 16], [18, 16]]) drawPlant(ctx, ...plant);
}

/** Draw one employee with feet at the bottom of the tile at (px, py). */
function drawPerson(ctx, px, py, look, dir, step, pose, frame) {
  const ox = px + 4;
  if (pose === "sleep") {
    // Lying on the sofa, one tile up from where they stand.
    const y = py - 11;
    rect(ctx, px - 2, y, 6, 6, look.skin);
    rect(ctx, px - 2, y, 6, 2, look.hair);
    rect(ctx, px + 4, y, 9, 6, look.shirt);
    rect(ctx, px + 13, y + 1, 5, 4, look.pants);
    return;
  }
  const seated = pose === "sit";
  const bob = seated ? (frame % 20 < 10 ? 0 : 1) : 0;
  const top = py + 1 + (seated ? 2 : 0);
  if (!seated) rect(ctx, px + 3, py + 14, 10, 2, C.shadow);
  // Legs.
  if (!seated) {
    const lift = step ? 1 : 0;
    rect(ctx, ox + 1, top + 12, 2, 3 - (step === 1 ? lift : 0), look.pants);
    rect(ctx, ox + 5, top + 12, 2, 3 - (step === 2 ? lift : 0), look.pants);
    rect(ctx, ox + 1, top + 14 - (step === 1 ? lift : 0), 2, 1, C.ink);
    rect(ctx, ox + 5, top + 14 - (step === 2 ? lift : 0), 2, 1, C.ink);
  }
  // Body and arms.
  rect(ctx, ox, top + 7, 8, 5, look.shirt);
  rect(ctx, ox, top + 11, 8, 1, look.shirtDark);
  const swing = step === 1 ? 1 : step === 2 ? -1 : 0;
  if (dir === "left" || dir === "right") {
    rect(ctx, ox + 3, top + 8 + swing, 2, 4, look.shirtDark);
  } else {
    rect(ctx, ox - 1, top + 8 + swing - bob, 1, 3, look.shirt);
    rect(ctx, ox + 8, top + 8 - swing + bob, 1, 3, look.shirt);
    rect(ctx, ox - 1, top + 11 + swing - bob, 1, 1, look.skin);
    rect(ctx, ox + 8, top + 11 - swing + bob, 1, 1, look.skin);
  }
  // Head.
  rect(ctx, ox, top, 8, 7, look.skin);
  if (dir === "up") {
    rect(ctx, ox, top, 8, 6, look.hair);
  } else if (dir === "down") {
    rect(ctx, ox, top, 8, 3, look.hair);
    rect(ctx, ox, top, 1, 5, look.hair);
    rect(ctx, ox + 7, top, 1, 5, look.hair);
    rect(ctx, ox + 2, top + 4, 1, 1, C.ink);
    rect(ctx, ox + 5, top + 4, 1, 1, C.ink);
  } else {
    rect(ctx, ox, top, 8, 3, look.hair);
    const back = dir === "left" ? ox + 5 : ox;
    rect(ctx, back, top, 3, 5, look.hair);
    rect(ctx, dir === "left" ? ox + 1 : ox + 6, top + 4, 1, 1, C.ink);
  }
}

// ---------- the office ----------
export function createOffice(ui) {
  const { h, ago, until, formatNumber, formatCompact, statusPill, taskStatus } = ui;
  const root = document.getElementById("office-view");
  const canvas = document.getElementById("office-canvas");
  const overlay = document.getElementById("office-overlay");
  const panel = document.getElementById("office-panel");
  const hotbar = document.getElementById("office-hotbar");
  const hud = document.getElementById("office-hud");
  const toasts = document.getElementById("office-toasts");
  const ctx = canvas.getContext("2d");
  canvas.width = WORLD_W * WORLD_SCALE;
  canvas.height = WORLD_H * WORLD_SCALE;
  ctx.imageSmoothingEnabled = false;

  const employees = new Map();
  let state = null;
  let selected = null; // agent name, or "new" for the assign form
  let focusTaskId = null; // task shown in the panel
  let pinnedTask = false; // the person picked a task from the history list
  let detail = null;
  let log = { taskId: null, offset: -1, text: "" };
  let tab = "conversation";
  let frame = 0;
  let running = false;
  let token = null;
  let panelFor = null; // which selection the panel skeleton was built for
  const slots = {};

  const at = (x, y) => ({ left: `${(x / WORLD_W) * 100}%`, top: `${(y / WORLD_H) * 100}%` });
  const place = (element, x, y) => {
    const position = at(x, y);
    element.style.left = position.left;
    element.style.top = position.top;
  };

  // Signs and clickable furniture.
  const signs = [
    ["Desks", 8.5 * T, 2.6 * T],
    ["Lounge", 24.5 * T, 8.1 * T],
    ["Meeting room: needs you", 24.5 * T, 15.6 * T],
    ["Review board", 5 * T, 11.9 * T],
    ["Your desk", 10.5 * T, 15.6 * T],
  ];
  for (const [text, x, y] of signs) {
    const sign = h("span", { class: "office-sign", text });
    place(sign, x, y);
    overlay.append(sign);
  }
  const hotspot = (label, x, y, w, hgt, onclick) => {
    const button = h("button", { class: "office-spot", type: "button", "aria-label": label, title: label, onclick },
      h("span", { class: "office-spot-label", text: label }));
    place(button, x, y);
    button.style.width = `${(w / WORLD_W) * 100}%`;
    button.style.height = `${(hgt / WORLD_H) * 100}%`;
    overlay.append(button);
    return button;
  };
  hotspot("Your desk: assign a task", 9 * T, 12 * T + 8, 3 * T, 2 * T, () => select("new"));
  hotspot("Review board", 3 * T, 12 * T + 4, 4 * T, 2 * T - 4, () => select(null, "review"));
  const mailSpot = hotspot("Mailbox: notices", 16 * T, 15 * T + 6, T, T + 8, () => select(null, "notices"));

  // ---------- controls ----------
  async function control(path, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!token) token = (await (await fetch("/api/session")).json()).token;
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ShareLane-Token": token },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => ({}));
      // A restarted dashboard has a new token; fetch it once and retry.
      if (response.status === 403 && attempt === 0) { token = null; continue; }
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      return data;
    }
    throw new Error("The dashboard refused the request.");
  }

  function toast(text, tone = "") {
    const item = h("div", { class: `toast ${tone}`, role: tone === "critical" ? "alert" : "status", text });
    toasts.append(item);
    setTimeout(() => item.remove(), 6000);
  }

  async function act(label, path, body, button) {
    if (button) button.disabled = true;
    try {
      await control(path, body);
      toast(label, "good");
      if (typeof onChange === "function") await onChange();
      return true;
    } catch (error) {
      toast(error.message, "critical");
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }
  let onChange = null;

  // ---------- employees ----------
  function lookFor(name, index) {
    return looks[name] ?? spareLooks[index % spareLooks.length];
  }

  function targetFor(employee, index) {
    const desk = deskSlots[index % deskSlots.length];
    const seat = [desk[0] + 1, desk[1] + 1];
    switch (employee.mode) {
      case "work":
      case "queued":
      case "paused":
        return { tile: seat, pose: "sit", dir: "up" };
      case "review": {
        const reviewers = [...employees.values()].filter((other) => other.mode === "review");
        return { tile: reviewSpots[Math.max(0, reviewers.indexOf(employee)) % reviewSpots.length], pose: "stand", dir: "up" };
      }
      case "needs": {
        const waiting = [...employees.values()].filter((other) => other.mode === "needs");
        const spot = meetingSpots[Math.max(0, waiting.indexOf(employee)) % meetingSpots.length];
        return { tile: spot, pose: "stand", dir: spot[1] === 11 ? "down" : "up" };
      }
      case "tired": {
        const tired = [...employees.values()].filter((other) => other.mode === "tired");
        return { tile: [sofaSpots[Math.max(0, tired.indexOf(employee)) % sofaSpots.length][0], 4], pose: "sleep", dir: "down" };
      }
      default:
        return null; // wander the lounge
    }
  }

  let firstSync = true;
  function syncEmployees() {
    const names = state.agents.map((agent) => agent.name);
    for (const name of [...employees.keys()]) {
      if (!names.includes(name)) {
        employees.get(name).element.remove();
        employees.delete(name);
      }
    }
    state.agents.forEach((agent, index) => {
      let employee = employees.get(agent.name);
      if (!employee) {
        const element = h("button", { class: "employee", type: "button", onclick: () => select(agent.name) },
          h("span", { class: "bubble", "aria-hidden": "true" }),
          h("span", { class: "plate" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "plate-name" })));
        overlay.append(element);
        employee = {
          name: agent.name, index, look: lookFor(agent.name, index), element,
          x: door[0], y: door[1], path: [], dir: "up", step: 0, pose: "stand",
          mode: "idle", target: null, wanderAt: 0, stepClock: 0,
        };
        employees.set(agent.name, employee);
      }
      const task = primaryTask(state, agent.name);
      employee.index = index;
      employee.agent = agent;
      employee.task = task;
      employee.mode = modeFor(agent, task);
    });
    for (const employee of employees.values()) {
      const target = targetFor(employee, employee.index);
      if (firstSync) {
        // On page load everyone starts where they belong; later changes are walked.
        const spot = target?.tile ?? [lounge.x1 + 1 + employee.index * 2, lounge.y1 + 1 + (employee.index % 2)];
        employee.x = spot[0];
        employee.y = spot[1];
      }
      const goal = target?.tile;
      if (goal && (!employee.goal || employee.goal[0] !== goal[0] || employee.goal[1] !== goal[1])) {
        employee.goal = goal;
        employee.path = findPath([Math.round(employee.x), Math.round(employee.y)], goal);
      }
      if (!goal && employee.target) employee.goal = null;
      employee.target = target;
      const info = modes[employee.mode];
      const name = employee.agent.displayName;
      employee.element.setAttribute("aria-label", `${name}: ${info.label}. ${statusLine(employee.mode, employee.task)}`);
      employee.element.setAttribute("aria-pressed", String(selected === employee.name));
      employee.element.className = `employee ${info.tone}${selected === employee.name ? " selected" : ""}`;
      employee.element.querySelector(".plate-name").textContent = name;
      const bubble = employee.element.querySelector(".bubble");
      bubble.textContent = info.bubble;
      bubble.hidden = !info.bubble;
      bubble.className = `bubble ${employee.mode}`;
    }
    firstSync = false;
  }

  function moveEmployee(employee, seconds) {
    if (!employee.path.length) {
      if (employee.target) {
        employee.pose = employee.target.pose;
        employee.dir = employee.target.dir;
        employee.step = 0;
      } else {
        employee.pose = "stand";
        employee.step = 0;
        if (performance.now() > employee.wanderAt) {
          employee.wanderAt = performance.now() + 2500 + Math.random() * 5000;
          const options = [];
          for (let x = lounge.x1; x <= lounge.x2; x += 1) for (let y = lounge.y1; y <= lounge.y2; y += 1) if (walkable(x, y)) options.push([x, y]);
          const spot = options[Math.floor(Math.random() * options.length)];
          if (Math.random() < 0.7) employee.path = findPath([Math.round(employee.x), Math.round(employee.y)], spot);
          else employee.dir = ["down", "left", "right"][Math.floor(Math.random() * 3)];
        }
      }
      return;
    }
    employee.pose = "walk";
    const [tx, ty] = employee.path[0];
    const dx = tx - employee.x;
    const dy = ty - employee.y;
    const distance = Math.hypot(dx, dy);
    const travel = SPEED * seconds;
    if (Math.abs(dx) > Math.abs(dy)) employee.dir = dx > 0 ? "right" : "left";
    else if (dy !== 0) employee.dir = dy > 0 ? "down" : "up";
    if (distance <= travel) {
      employee.x = tx;
      employee.y = ty;
      employee.path.shift();
    } else {
      employee.x += (dx / distance) * travel;
      employee.y += (dy / distance) * travel;
    }
    employee.stepClock += seconds;
    employee.step = Math.floor(employee.stepClock * 8) % 4 === 1 ? 1 : Math.floor(employee.stepClock * 8) % 4 === 3 ? 2 : 0;
  }

  function draw() {
    ctx.setTransform(WORLD_SCALE, 0, 0, WORLD_SCALE, 0, 0);
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    drawFloor(ctx);
    drawWalls(ctx);
    const list = [...employees.values()];
    const screens = list
      .sort((a, b) => a.index - b.index)
      .map((employee) => {
        const seated = employee.pose === "sit";
        if (employee.mode === "work" && seated) return "on";
        if (employee.mode === "paused") return "paused";
        if (employee.mode === "needs") return "alert";
        return "off";
      });
    while (screens.length < 3) screens.push("off");
    drawFurniture(ctx, frame, screens, state?.notices.filter((notice) => !notice.delivered).length ?? 0);
    // Empty chairs at desks nobody is sitting at.
    screens.forEach((_, index) => {
      const [x, y] = deskSlots[index];
      const sitting = list.some((employee) => employee.pose === "sit" && employee.index === index);
      if (!sitting) drawChair(ctx, x + 1, y + 1);
    });
    for (const employee of [...list].sort((a, b) => a.y - b.y)) {
      const px = employee.x * T;
      const py = employee.y * T;
      withSprite(ctx, employee.x, employee.y, () => {
        drawPerson(ctx, 0, 0, employee.look, employee.dir, employee.step, employee.pose, frame + employee.index * 7);
        if (employee.pose === "sit") drawChairBack(ctx, 0, 0);
      });
      const lift = employee.pose === "sleep" ? -10 : 0;
      // The sprite's head is 16 * SPRITE_SCALE / WORLD_SCALE world pixels above its feet.
      place(employee.element, px + T / 2, py + T - (16 * SPRITE_SCALE) / WORLD_SCALE + lift);
    }
  }

  let last = performance.now();
  function loop(now) {
    if (!running) return;
    const seconds = Math.min(0.1, (now - last) / 1000);
    last = now;
    frame += 1;
    for (const employee of employees.values()) moveEmployee(employee, seconds);
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- HUD and hotbar ----------
  function renderHud() {
    const counts = { work: 0, paused: 0, review: 0, needs: 0 };
    for (const employee of employees.values()) {
      if (employee.mode === "queued") counts.work += 1;
      else if (employee.mode in counts) counts[employee.mode] += 1;
    }
    const chip = (label, value, tone) => h("span", { class: `hud-chip ${value ? tone : ""}` }, h("strong", { text: String(value) }), ` ${label}`);
    hud.replaceChildren(
      h("span", { class: "hud-project", text: state.project.name }),
      chip("working", counts.work, "active"),
      chip("paused", counts.paused, "warning"),
      chip("to review", counts.review, "good"),
      chip("need you", counts.needs, "critical"));
  }

  function portrait(employee, size = 3) {
    const small = document.createElement("canvas");
    small.width = 16;
    small.height = 16;
    small.className = "portrait";
    small.style.width = `${16 * size}px`;
    small.style.height = `${16 * size}px`;
    const pctx = small.getContext("2d");
    pctx.imageSmoothingEnabled = false;
    drawPerson(pctx, 0, 0, employee.look, "down", 0, "stand", 0);
    return small;
  }

  const hotbarSlots = new Map();
  function renderHotbar() {
    for (const employee of employees.values()) {
      let slot = hotbarSlots.get(employee.name);
      if (!slot) {
        slot = h("button", { class: "slot", type: "button", onclick: () => select(employee.name) },
          portrait(employee, 2), h("span", { class: "slot-name" }), h("span", { class: "slot-dot", "aria-hidden": "true" }));
        hotbarSlots.set(employee.name, slot);
      }
      const info = modes[employee.mode];
      slot.className = `slot ${info.tone}${selected === employee.name ? " selected" : ""}`;
      slot.querySelector(".slot-name").textContent = employee.agent.displayName;
      slot.setAttribute("aria-label", `${employee.agent.displayName}: ${info.label}`);
      slot.title = `${employee.agent.displayName}: ${info.label}`;
    }
    if (!slots.assign) {
      slots.assign = h("button", { class: "slot action", type: "button", onclick: () => select("new"), title: "Assign a task" },
        h("span", { class: "slot-icon", "aria-hidden": "true", text: "+" }), h("span", { class: "slot-name", text: "New task" }));
      slots.mail = h("button", { class: "slot action", type: "button", onclick: () => select(null, "notices"), title: "Notices" },
        h("span", { class: "slot-icon", "aria-hidden": "true", text: "✉" }), h("span", { class: "slot-name" }));
    }
    const unread = state.notices.filter((notice) => !notice.delivered).length;
    slots.mail.querySelector(".slot-name").textContent = unread ? `Notices (${unread})` : "Notices";
    mailSpot.setAttribute("aria-label", `Mailbox: ${unread} notice${unread === 1 ? "" : "s"} waiting for an agent`);
    const wanted = [...hotbarSlots.values(), slots.assign, slots.mail];
    // Re-append only when the set changes, so keyboard focus survives refreshes.
    if (wanted.some((slot, index) => hotbar.children[index] !== slot) || hotbar.children.length !== wanted.length) {
      hotbar.replaceChildren(...wanted);
    }
  }

  // ---------- side panel ----------
  let lobby = "team"; // what the panel shows when no employee is selected

  function select(name, view = "team") {
    selected = name;
    if (!name) lobby = view;
    focusTaskId = null;
    pinnedTask = false;
    detail = null;
    log = { taskId: null, offset: -1, text: "" };
    tab = "conversation";
    panelFor = null;
    refresh();
    panel.focus({ preventScroll: true });
    if (typeof onChange === "function") onChange();
  }

  const statusOf = (task) => taskStatus[task.status] ?? { tone: "", icon: "?", label: task.status };

  function quotaMeters(agent) {
    const quota = agent.quota;
    if (!quota.windows.length) return h("p", { class: "muted", text: quota.reason || "No allowance reading yet." });
    return h("div", { class: "office-meters" }, quota.windows.map((window) => {
      const low = window.remainingPercent <= quota.threshold;
      return h("div", { class: "meter-row" },
        h("span", { text: window.name.replace(/^\w/, (c) => c.toUpperCase()) }),
        h("div", { class: `meter${quota.state === "unknown" ? " uncertain" : ""}`, role: "meter", "aria-valuemin": 0, "aria-valuemax": 100,
          "aria-valuenow": window.remainingPercent, "aria-label": `${window.name} window: ${window.remainingPercent}% left` },
          h("div", { class: `meter-fill${low ? " low" : ""}`, style: `width:${Math.max(0, Math.min(100, window.remainingPercent))}%` })),
        h("span", { class: "num", text: `${quota.state === "unknown" ? "~" : ""}${window.remainingPercent}%${window.resetsAt && Date.parse(window.resetsAt) > Date.now() ? ` · resets ${until(window.resetsAt)}` : ""}` }));
    }));
  }

  function taskControls(task) {
    const buttons = [];
    const path = (action) => `/api/tasks/${encodeURIComponent(task.id)}/${action}`;
    if (task.status === "running" || task.status === "queued") {
      buttons.push(h("button", { class: "btn", type: "button", onclick: (event) => act("Paused. The work so far is saved on the task branch.", path("pause"), {}, event.currentTarget) }, "❚❚ Pause"));
    }
    if (task.status === "paused") {
      buttons.push(h("button", { class: "btn primary", type: "button", onclick: (event) => act("Resumed.", path("resume"), {}, event.currentTarget) }, "▶ Resume"));
    }
    if (["running", "queued", "paused", "needs_reassignment"].includes(task.status)) {
      buttons.push(h("button", { class: "btn danger", type: "button", onclick: (event) => {
        if (confirm("Stop this task? Its changes so far stay on the task branch, but it cannot be resumed.")) {
          act("Stopped.", path("stop"), {}, event.currentTarget);
        }
      } }, "■ Stop"));
    }
    return buttons;
  }

  function composer(task) {
    // Built once per focused task so typing is never interrupted by refreshes.
    const canTalk = task.status === "completed" || task.status === "paused";
    const textarea = h("textarea", { rows: 3, placeholder: task.status === "paused"
      ? "Optional: add an instruction, then resume"
      : "Ask a follow-up in the same conversation", "aria-label": "Message to the agent" });
    const send = h("button", { class: "btn primary", type: "submit" }, task.status === "paused" ? "Resume with note" : "Send");
    const form = h("form", { class: "composer", onsubmit: async (event) => {
      event.preventDefault();
      const message = textarea.value.trim();
      if (task.status !== "paused" && !message) return;
      const ok = await act(task.status === "paused" ? "Resumed with your note." : "Message sent. The agent is working on it.",
        `/api/tasks/${encodeURIComponent(task.id)}/${task.status === "paused" ? "resume" : "reply"}`, { message }, send);
      if (ok) textarea.value = "";
    } }, textarea, h("div", { class: "row" }, h("span", { class: "muted", text: canTalk ? "" : "You can message the agent once this run finishes or is paused." }), send));
    textarea.disabled = !canTalk;
    send.disabled = !canTalk;
    return form;
  }

  function newTaskForm(agentName) {
    const agentSelect = h("select", { "aria-label": "Agent" }, state.agents.map((agent) =>
      h("option", { value: agent.name, selected: agent.name === agentName, text: `${agent.displayName}${agent.quota.state === "handoff" ? " (out of allowance)" : ""}` })));
    const prompt = h("textarea", { rows: 5, required: true, placeholder: "What should they do? Name the files and what “done” looks like.", "aria-label": "Task" });
    const scope = h("input", { type: "text", placeholder: "Optional: src/ui/**, README.md", "aria-label": "Allowed files" });
    const budget = h("input", { type: "number", min: 1000, step: 1000, placeholder: "Optional, e.g. 200000", "aria-label": "Token budget" });
    const submit = h("button", { class: "btn primary", type: "submit" }, "Assign task");
    return h("form", { class: "new-task", onsubmit: async (event) => {
      event.preventDefault();
      if (!prompt.value.trim()) return;
      const body = { agent: agentSelect.value, prompt: prompt.value };
      if (scope.value.trim()) body.scope = scope.value;
      if (budget.value) body.budgetTokens = Number(budget.value);
      const ok = await act("Task assigned. Watch them head to their desk.", "/api/tasks", body, submit);
      if (ok) { prompt.value = ""; scope.value = ""; budget.value = ""; select(agentSelect.value); }
    } },
    h("label", {}, h("span", { text: "Who" }), agentSelect),
    h("label", {}, h("span", { text: "Task" }), prompt),
    h("label", {}, h("span", { text: "Allowed files" }), scope, h("small", { class: "muted", text: "Leave empty to allow the whole project. Patterns are separated by commas." })),
    h("label", {}, h("span", { text: "Token budget" }), budget),
    h("div", { class: "row" }, h("span", { class: "muted", text: "They work on their own branch. Nothing is merged without you." }), submit));
  }

  function lobbyPanel() {
    if (lobby === "notices") {
      return [h("h2", { text: "Mailbox" }), h("p", { class: "muted", text: "Notices ShareLane sends to agents: handoffs, budget warnings, scope problems." }),
        h("ul", { class: "list" }, state.notices.length ? state.notices.slice(0, 15).map((notice) => h("li", {},
          h("div", { class: "row" }, h("strong", { text: notice.kind.replaceAll("_", " ") }), h("span", { class: "meta", text: `${ago(notice.createdAt)} · ${notice.delivered ? "delivered" : "waiting"}` })),
          h("div", { class: "text", text: notice.message }))) : [h("li", { class: "meta", text: "No notices." })])];
    }
    if (lobby === "review") {
      const ready = state.tasks.filter((task) => task.status === "completed" && task.changedFiles.length && task.branchName);
      return [h("h2", { text: "Review board" }), h("p", { class: "muted", text: "Finished work waits on its own branch. Review it with git before merging." }),
        h("ul", { class: "list" }, ready.length ? ready.slice(0, 12).map((task) => h("li", {},
          h("div", { class: "row" }, h("strong", { text: task.title || task.id }), h("span", { class: "meta", text: `${task.agent} · ${ago(task.finishedAt ?? task.updatedAt)}` })),
          h("div", { class: "meta", text: task.changedFiles.join(", ") }),
          h("code", { class: "command", text: `git diff main...${task.branchName}` }))) : [h("li", { class: "meta", text: "Nothing waiting for review." })])];
    }
    return [h("h2", { text: "Your team" }), h("p", { class: "muted", text: "Click someone on the floor, or below, to see what they're doing and to direct them." }),
      h("ul", { class: "team" }, [...employees.values()].map((employee) => h("li", {},
        h("button", { class: "team-row", type: "button", onclick: () => select(employee.name) },
          portrait(employee, 2),
          h("span", { class: "team-text" }, h("strong", { text: employee.agent.displayName }), h("span", { class: "muted", text: statusLine(employee.mode, employee.task) })),
          statusPill({ tone: modes[employee.mode].tone, icon: modes[employee.mode].bubble || "•", label: modes[employee.mode].label }))))),
      h("button", { class: "btn primary wide", type: "button", onclick: () => select("new") }, "+ Assign a new task")];
  }

  function refresh() {
    if (!state) return;
    renderHud();
    renderHotbar();
    if (selected === "new") {
      if (panelFor !== "new") {
        panelFor = "new";
        panel.replaceChildren(h("div", { class: "panel-top" }, h("h2", { text: "Assign a task" }), h("button", { class: "ghost", type: "button", onclick: () => select(null) }, "Close")),
          newTaskForm(state.agents[0]?.name));
      }
      return;
    }
    const employee = selected ? employees.get(selected) : null;
    if (!employee) {
      panelFor = null;
      panel.replaceChildren(...lobbyPanel());
      return;
    }
    if (!pinnedTask) focusTaskId = employee.task?.id ?? null;
    const task = focusTaskId ? state.tasks.find((candidate) => candidate.id === focusTaskId) ?? employee.task : null;
    const skeletonKey = `${employee.name}|${task?.id ?? ""}|${task?.status ?? ""}`;
    if (panelFor !== skeletonKey) {
      panelFor = skeletonKey;
      panel.replaceChildren(
        h("div", { class: "panel-top" },
          h("div", { class: "who" }, portrait(employee, 3), h("div", {}, h("h2", { text: employee.agent.displayName }), h("p", { class: "muted mono", text: employee.name }))),
          h("button", { class: "ghost", type: "button", onclick: () => select(null) }, "Close")),
        h("p", { class: "mood", "data-part": "mood" }),
        h("section", { class: "card" }, h("h3", { text: "Allowance" }), h("div", { "data-part": "quota" })),
        task ? h("section", { class: "card" },
          h("div", { class: "row" }, h("h3", { text: "Current task" }), h("span", { "data-part": "status" })),
          h("p", { class: "task-name", text: task.title || task.id }),
          h("dl", { class: "facts", "data-part": "facts" }),
          h("div", { class: "controls" }, taskControls(task)),
          composer(task),
          h("div", { class: "tabs", role: "tablist" }, [["conversation", "Conversation"], ["output", "Live output"]].map(([value, label]) =>
            h("button", { class: "tab", type: "button", role: "tab", "data-tab": value, "aria-selected": String(tab === value),
              onclick: async () => {
                tab = value;
                for (const button of panel.querySelectorAll("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
                if (value === "output") await loadLog();
                refresh();
              } }, label))),
          h("div", { "data-part": "body" })) : h("section", { class: "card" }, h("p", { class: "muted", text: "No tasks yet." })),
        h("section", { class: "card" }, h("h3", { text: "Task history" }), h("ul", { class: "history", "data-part": "history" })),
        h("details", { class: "card" }, h("summary", { text: `Give ${employee.agent.displayName} a new task` }), newTaskForm(employee.name)));
    }
    const part = (name) => panel.querySelector(`[data-part="${name}"]`);
    part("mood").textContent = statusLine(employee.mode, employee.task);
    part("quota").replaceChildren(quotaMeters(employee.agent));
    if (task) {
      part("status").replaceChildren(statusPill(statusOf(task)));
      part("facts").replaceChildren(...[
        h("dt", { text: "Branch" }), h("dd", { class: "mono", text: task.branchName ?? "direct workspace" }),
        h("dt", { text: "Changed" }), h("dd", { class: "mono", text: task.changedFiles.length ? task.changedFiles.join(", ") : "nothing yet" }),
        h("dt", { text: "Allowed" }), h("dd", { class: "mono", text: task.scope?.length ? task.scope.join(", ") : "whole project" }),
        h("dt", { text: "Tokens" }), h("dd", { class: "num", text: `${formatCompact(task.freshTokens)} fresh${task.budgetTokens ? ` of ${formatCompact(task.budgetTokens)} budget` : ""} · ${task.usage.runs} run(s)` }),
        task.error ? [h("dt", { text: "Problem" }), h("dd", { text: task.error })] : null,
        task.scopeViolations.length ? [h("dt", { text: "Kept off" }), h("dd", { class: "mono", text: task.scopeViolations.join(", ") })] : null,
      ].flat().filter(Boolean));
      const body = part("body");
      if (tab === "output") {
        const text = log.text || "No output yet. Some agents print everything at the end of a run.";
        const pre = scrollBox(body, "log-box", () => h("pre", { class: "log", "aria-label": "Agent output", tabindex: 0 }));
        updateKeepingScroll(pre, text, () => { pre.textContent = text; });
      } else {
        const messages = detail?.task.id === task.id ? detail.messages : [];
        const chat = scrollBox(body, "chat-box", () => h("div", { class: "chat", tabindex: 0, "aria-label": "Conversation" }));
        const signature = `${task.id}|${messages.length}|${messages.at(-1)?.createdAt ?? ""}`;
        updateKeepingScroll(chat, signature, () => chat.replaceChildren(...(messages.length ? messages.map((message) => h("div", { class: `bubble-msg ${message.role}` },
          h("div", { class: "meta", text: `${message.role === "user" ? "Request" : employee.agent.displayName} · ${ago(message.createdAt)}` }),
          h("div", { class: "text", text: message.content.length > 6000 ? `${message.content.slice(0, 6000)}\n… (${formatNumber(message.content.length - 6000)} more characters in the task file)` : message.content }))) : [h("p", { class: "muted", text: "Loading the conversation…" })])));
      }
    }
    const history = agentTasks(state, employee.name).slice(0, 10);
    const historyList = part("history");
    const historyKey = `${task?.id}|${history.map((item) => `${item.id}:${item.status}:${item.updatedAt}`).join(",")}|${Math.floor(Date.now() / 60_000)}`;
    if (historyList.dataset.signature === historyKey) return;
    historyList.dataset.signature = historyKey;
    historyList.replaceChildren(...(history.length ? history.map((item) => h("li", {},
      h("button", { class: `history-row${item.id === task?.id ? " current" : ""}`, type: "button", onclick: () => {
        focusTaskId = item.id; pinnedTask = true; detail = null; log = { taskId: null, offset: -1, text: "" }; panelFor = null;
        if (typeof onChange === "function") onChange();
      } }, statusPill(statusOf(item)), h("span", { class: "history-title", text: item.title || item.id }), h("span", { class: "meta", text: ago(item.updatedAt) })))) : [h("li", { class: "meta", text: "Nothing yet." })]));
  }

  // Scrollable boxes are kept between refreshes (a new element would reset the
  // reader's scroll position every 2 seconds) and only change when their
  // content does. They follow new content only if the reader was at the bottom.
  function scrollBox(container, kind, create) {
    const current = container.firstElementChild;
    if (current?.dataset.box === kind) return current;
    const box = create();
    box.dataset.box = kind;
    box.dataset.fresh = "1";
    container.replaceChildren(box);
    return box;
  }

  function updateKeepingScroll(box, signature, update) {
    if (box.dataset.signature === signature) return;
    const fresh = box.dataset.fresh === "1";
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    const previousTop = box.scrollTop;
    box.dataset.signature = signature;
    delete box.dataset.fresh;
    update();
    box.scrollTop = fresh || atBottom ? box.scrollHeight : previousTop;
  }

  async function loadDetail() {
    if (!focusTaskId) return;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(focusTaskId)}`);
      if (response.ok) detail = await response.json();
    } catch {
      // Keep the last detail on a transient error.
    }
  }

  async function loadLog() {
    if (!focusTaskId || tab !== "output") return;
    if (log.taskId !== focusTaskId) log = { taskId: focusTaskId, offset: -1, text: "" };
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(focusTaskId)}/log?offset=${log.offset}`);
      if (!response.ok) return;
      const chunk = await response.json();
      if (chunk.text) log.text = (log.text + chunk.text).slice(-200_000);
      log.offset = chunk.nextOffset;
    } catch {
      // Retry on the next refresh.
    }
  }

  return {
    async update(next) {
      state = next;
      syncEmployees();
      if (selected && selected !== "new") {
        const employee = employees.get(selected);
        if (employee && !pinnedTask) focusTaskId = employee.task?.id ?? null;
        await loadDetail();
        await loadLog();
      }
      refresh();
    },
    setActive(active) {
      root.hidden = !active;
      if (active && !running) {
        running = true;
        last = performance.now();
        requestAnimationFrame(loop);
      } else if (!active) {
        running = false;
      }
    },
    onChange(callback) {
      onChange = callback;
    },
  };
}
