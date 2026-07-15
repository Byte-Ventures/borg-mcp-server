import { installNodeServerTestHooks } from "../../dist/service.js";

const phase = process.env["BORG_TEST_PHASE"];
if (phase === undefined || process.send === undefined) process.exit(2);

const readiness = setInterval(() => process.send({ phase: "preload-ready" }), 25);
process.send({ phase: "preload-ready" });
await new Promise((resolve) => process.once("message", (message) => {
  if (message === "start") resolve();
}));
clearInterval(readiness);

let continuePhase;
const continued = new Promise((resolve) => { continuePhase = resolve; });
process.on("message", (message) => {
  if (message === "continue") continuePhase();
});

const barrier = async (name) => {
  if (phase !== name) return;
  process.send({ phase: name });
  await continued;
};

installNodeServerTestHooks({
  onStartupPhase: barrier,
  onSignalObserved: () => {
    process.send({ phase: "signal-observed" });
    const readyToDisconnect = phase === "live-listener" ? Promise.resolve() : continued;
    void readyToDisconnect.then(() => {
      process.removeAllListeners("message");
      process.disconnect();
    });
  },
  onListening: (origin) => process.send({ phase: "live-listener", origin }),
  wrapRunningServer: (running) => ({
    ...running,
    close: async () => {
      await barrier("shutdown-in-progress");
      if (process.env["BORG_TEST_CLOSE_REJECT"] === "1") {
        throw new Error("secret child close detail");
      }
      await running.close();
    },
  }),
});
