---
title: Data and storage
read-when: Changing stored data, schemas, search, migrations, or persistence.
covers-files: ["src/db/**","src/core/database.ts","src/core/context.ts","src/core/memory.ts"]
updated-at: 2026-09-26T20:50:49.184Z
source-hash: 483e116ec3ca488f7087280e3b263c3ad5e55341371b01ad720b01659663de1f
---

# Data and storage

Curated context lives in committed Markdown files under .sharelane/context. MAP.md is generated; the other files are editable topic chunks with title, read-when, covers-files, updated-at, and optional source-hash headers.

Local runtime state lives in .sharelane/sharelane.db using SQLite WAL mode. The chunks and journal tables hold structured records, and the FTS5 search_index table provides word search. The database, WAL files, raw journal, and legacy notes are ignored by Git because they can be rebuilt or are noisy runtime data.
