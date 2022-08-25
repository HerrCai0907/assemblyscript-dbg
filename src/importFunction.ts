import { DebugSession, OutputEvent, TerminatedEvent } from "@vscode/debugadapter";

function getString(offset: number, memory: Uint8Array): string {
  if (offset < 4) {
    return "";
  }
  const length = Buffer.from(memory).readUInt32LE(offset - 4);
  return Buffer.from(memory.slice(offset, offset + length)).toString("utf16le");
}

export function trace(session: DebugSession, args: number[], memory: Uint8Array): null {
  const offset = args[0];
  const n = args[1];
  let e = new OutputEvent(`trace: ${getString(offset, memory)}${n ? " " : ""}${args.slice(2, 2 + n).join(", ")}\n`, "console");
  session.sendEvent(e);
  return null;
}

export function abort(session: DebugSession, args: number[], memory: Uint8Array): null {
  const [msg, file, line, colm] = args;
  let e = new OutputEvent(`abort: ${getString(msg, memory)} at ${getString(file, memory)}:${line}:${colm}\n`, "stderr");
  session.sendEvent(e);
  session.sendEvent(new TerminatedEvent());
  return null;
}
