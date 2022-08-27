import { OutputEvent, StoppedEvent } from "@vscode/debugadapter";
import { DebugSession } from "./debug";

export class DebugSessionWrapper {
  constructor(private session: DebugSession) {}
  logInfo(message: string) {
    const e = new OutputEvent(message + "\n", "console");
    this.session.sendEvent(e);
  }
  logError(message: string) {
    const e = new OutputEvent(message + "\n", "stderr");
    this.session.sendEvent(e);
  }
  throwException(e: Error) {
    this.logError(`${e.message}`);
    this.session.sendEvent(new StoppedEvent("exception"));
    throw e;
  }
  get helper() {
    return {
      getString(offset: number, memory: Uint8Array): string {
        if (offset < 4) {
          return "";
        }
        const length = Buffer.from(memory).readUInt32LE(offset - 4);
        return Buffer.from(memory.slice(offset, offset + length)).toString("utf16le");
      },
    };
  }
}
