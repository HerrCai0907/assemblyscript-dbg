import { OutputEvent, StoppedEvent } from "@vscode/debugadapter";
import { DebugSession } from "./debug";

export class DebugSessionWrapper {
  constructor(private session: DebugSession) {}
  logInfo(message: string) {
    let e = new OutputEvent(message, "console");
    this.session.sendEvent(e);
  }
  logError(message: string) {
    let e = new OutputEvent(message, "stderr");
    this.session.sendEvent(e);
  }
  throwException(e: unknown) {
    this.logError(`${e}`);
    this.session.sendEvent(new StoppedEvent("exception"));
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
