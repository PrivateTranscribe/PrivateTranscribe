// Deliberately crash ONLY the disposable utility process in the isolation probe.
process.parentPort.once("message", () => process.crash());
