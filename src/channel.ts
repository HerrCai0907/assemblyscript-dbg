import * as vscode from "vscode";
import { DEBUG_TYPE } from "./constant";

const channel = vscode.window.createOutputChannel(DEBUG_TYPE);

export function logInfo(msg: string) {
  channel.appendLine("[INFO] " + msg);
}

export function logWarn(msg: string) {
  channel.appendLine("[WARN] " + msg);
}

export function logError(msg: string) {
  channel.appendLine("[ERROR] " + msg);
}
