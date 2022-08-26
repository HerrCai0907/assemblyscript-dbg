/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * activateMockDebug.ts containes the shared extension code that can be executed both in node.js and the browser.
 */

"use strict";

import { TerminatedEvent } from "@vscode/debugadapter";
import { ChildProcess, execSync, spawn } from "child_process";
import * as vscode from "vscode";
import { ProviderResult } from "vscode";
import { DEBUG_TYPE } from "./constant";
import { DebugSession } from "./debug";

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

  createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
    try {
      // update
      console.log("installing wasm-grpc");
      execSync("cargo install wasmdbg-grpc --git https://github.com/HerrCai0907/wasmdbg.git", { stdio: "inherit" });
      // start server
      console.log("starting wasm-grpc");
      this.server = spawn("wasmdbg-grpc", { stdio: "pipe" });
      this.server.on("close", (code, signal) => {
        if (code != 0 && signal !== "SIGKILL") {
          void vscode.window.showErrorMessage("wasmdbg crash!");
          this.session?.sendEvent(new TerminatedEvent());
        }
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`wasmdbg start failed due to ${e}`);
    }

    this.session = new DebugSession();
    return new vscode.DebugAdapterInlineImplementation(this.session);
  }
  dispose() {
    this.session?.dispose();
    this.session = null;
    console.log("stop wasm-grpc");
    this.server?.kill("SIGKILL");
    this.server = null;
  }
}
