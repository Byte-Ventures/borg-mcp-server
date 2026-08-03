import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const clientRoot = process.env.BORG_OPERATOR_CLIENT_ROOT;
if (!clientRoot) throw new Error("BORG_OPERATOR_CLIENT_ROOT is required");

const { getActiveCube } = await import(pathToFileURL(join(clientRoot, "dist/cubes.js")).href);
const { appendLog, readLog } = await import(
  pathToFileURL(join(clientRoot, "dist/remote-client.js")).href
);

const active = await getActiveCube();
if (active === null) throw new Error("real client active cube missing after attach");

const message = `server-242-real-client-${randomUUID()}`;
const posted = await appendLog(active.sessionToken, active.apiUrl, message, {
  serverTrustIdentity: active.serverTrustIdentity,
});
if (posted?.entry?.message !== message || typeof posted.entry.id !== "string") {
  throw new Error("published client appendLog did not return the posted entry");
}

const page = await readLog(active.sessionToken, active.apiUrl, {
  limit: 20,
  serverTrustIdentity: active.serverTrustIdentity,
});
const readBack = page.entries.some(
  (entry) => entry.id === posted.entry.id && entry.message === message,
);
if (!readBack) throw new Error("published client readLog did not return the posted entry");

console.log(JSON.stringify({ active: true, posted: true, read: true }));
