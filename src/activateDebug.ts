import { TerminatedEvent } from "@vscode/debugadapter";
import { ChildProcess, execSync, spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import { DEBUG_TYPE } from "./constant";
import { DebugSession } from "./debug";
import getPort from "get-port";

export function activateDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {
  context.subscriptions.push(
    vscode.commands.registerCommand("extension.assemblyscript-debug.debugEditorContents", (resource?: vscode.Uri) => {
      let targetResource = resource;
      if (!targetResource && vscode.window.activeTextEditor) {
        targetResource = vscode.window.activeTextEditor.document.uri;
      }
      if (targetResource) {
        vscode.debug
          .startDebugging(undefined, {
            type: DEBUG_TYPE,
            name: "Debug File",
            request: "launch",
            program: targetResource.fsPath,
            cwd: vscode.workspace.getWorkspaceFolder(targetResource)?.uri.fsPath ?? "",
          })
          .then(undefined, (reason) => {
            void vscode.window.showErrorMessage(`assemblyscript debugger carash due to ${reason}`);
          });
      }
    })
  );

  if (!factory) {
    factory = new InlineDebugAdapterFactory();
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, factory));
  if ("dispose" in factory) {
    context.subscriptions.push(factory);
  }
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private session: DebugSession | null = null;
  private server: ChildProcess | null = null;

  async createDebugAdapterDescriptor(_session: vscode.DebugSession) {
    try {
      const dapPort = await getPort();
      const debuggerPort = dapPort;
      console.log(`starting wasm-grpc at ${debuggerPort} and ${dapPort}`);
      this.server = spawn("wasmdbg-grpc", ["-s", `[::1]:${debuggerPort}`, "-c", `http://127.0.0.1:${dapPort}`], {
        stdio: "inherit",
      });
      this.server.on("close", (code, signal) => {
        if (code != 0 && signal !== "SIGKILL") {
          void vscode.window.showErrorMessage(`wasmdbg crash! ${code} ${signal}`);
          this.session?.sendEvent(new TerminatedEvent());
        }
        this.server = null;
      });
      this.session = new DebugSession(debuggerPort, dapPort);
      return new vscode.DebugAdapterInlineImplementation(this.session);
    } catch (e) {
      void vscode.window.showErrorMessage(`wasmdbg start failed due to ${e}`);
    }
  }
  dispose() {
    this.session?.dispose();
    this.session = null;
    console.log("stop wasm-grpc");
    this.server?.kill("SIGKILL");
    this.server = null;
  }
}
