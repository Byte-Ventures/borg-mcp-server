import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "../../dist/store.js";
import { clientPrincipal } from "../../dist/principal.js";

const runtime = await openStore({ path: workerData.path });
const store = runtime.forPrincipal(clientPrincipal(workerData.clientId));
parentPort.once("message", () => {
  try {
    parentPort.postMessage({ result: store.reconcileAttachment(workerData.request) });
  } catch (error) {
    parentPort.postMessage({ code: error.code ?? "UNEXPECTED" });
  } finally {
    runtime.close();
    parentPort.close();
  }
});
parentPort.postMessage({ ready: true });
