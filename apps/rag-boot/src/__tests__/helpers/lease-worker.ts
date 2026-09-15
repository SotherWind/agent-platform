import { SqliteLeaseStore } from "../../reliability/lease-store";

const path = process.argv[2];
if (!path) throw new Error("Database path required.");
const store = new SqliteLeaseStore(path, "process-contention");
try {
  process.stdout.write(JSON.stringify(store.claim("same-operation", "same-content", Date.now(), 60_000)));
} finally {
  store.close();
}
