/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * activateMockDebug.ts containes the shared extension code that can be executed both in node.js and the browser.
 */

"use strict";

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
        vscode.debug.startDebugging(undefined, {
          type: DEBUG_TYPE,
          name: "Debug File",
          request: "launch",
          program: targetResource.fsPath,
          cwd: vscode.workspace.getWorkspaceFolder(targetResource)?.uri.fsPath ?? "",
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
  createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new DebugSession());
  }
}
