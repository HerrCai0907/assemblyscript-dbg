import { DebugSessionWrapper } from "./DebugSessionWrapper";

export function trace(extension: DebugSessionWrapper, args: number[], memory: Uint8Array): null {
  const offset = args[0];
  const n = args[1];
  extension.logInfo(`trace: ${extension.helper.getString(offset, memory)}${n ? " " : ""}${args.slice(2, 2 + n).join(", ")}\n`);
  return null;
}
export function abort(extension: DebugSessionWrapper, args: number[], memory: Uint8Array): null {
  const [msg, file, line, colm] = args;
  extension.throwException(
    `abort: ${extension.helper.getString(msg, memory)} at ${extension.helper.getString(file, memory)}:${line}:${colm}\n`
  );
  return null;
}
