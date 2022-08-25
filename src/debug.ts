import * as vscode from "vscode";
import {
  LoggingDebugSession,
  InitializedEvent,
  StoppedEvent,
  Thread,
  Scope,
  StackFrame,
  Source,
  TerminatedEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { WasmDebuggerClient } from "./proto/interface_grpc_pb";
import * as grpc from "@grpc/grpc-js";
import * as proto from "./proto/interface_pb";
import { basename } from "path";
import { SourceMapAnalysis, SourcePosition } from "./sourceMap";
import assert = require("assert");
import { FixedScopeId, ScopeId } from "./scopeId";

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** An absolute path to the "program" to debug. */
  program: string;
  /** An absolute path to the "workspace". */
  cwd: string;
}

export class DebugSession extends LoggingDebugSession {
  private static threadID = 1;

  private _configurationDone = false;
  private _client: WasmDebuggerClient;
  private _sourceMapAnalysis: SourceMapAnalysis | null = null;

  constructor() {
    super("assemblyscript-debugger.txt");

    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);

    this._client = new WasmDebuggerClient("[::1]:50051", grpc.credentials.createInsecure());
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // the adapter implements the configurationDone request.
    response.body.supportsConfigurationDoneRequest = true;

    this.sendResponse(response);

    // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
    // we request them early by sending an 'initializeRequest' to the frontend.
    // The frontend will end the configuration sequence by calling 'configurationDone' request.
    this.sendEvent(new InitializedEvent());
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   */
  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    super.configurationDoneRequest(response, args);
    this._configurationDone = true;
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
    request?: DebugProtocol.Request
  ): void {
    console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
  }

  //  ██████  ██████  ███████ ██████   █████  ████████  ██████  ██████
  // ██    ██ ██   ██ ██      ██   ██ ██   ██    ██    ██    ██ ██   ██
  // ██    ██ ██████  █████   ██████  ███████    ██    ██    ██ ██████
  // ██    ██ ██      ██      ██   ██ ██   ██    ██    ██    ██ ██   ██
  //  ██████  ██      ███████ ██   ██ ██   ██    ██     ██████  ██   ██

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    this._sourceMapAnalysis = new SourceMapAnalysis(args.program, args.cwd);

    // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
    let available = await new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(this._configurationDone);
      }, 1000);
    });
    if (!available) {
      this.errorHandler("configuration failed");
      return;
    }
    // load module
    let loadReply = await new Promise<proto.LoadReply.AsObject>((resolve) => {
      this._client.loadModule(new proto.LoadRequest().setFileName(args.program), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err}`);
        }
        resolve(reply.toObject());
      });
    });
    if (loadReply.status == proto.Status.NOK) {
      this.errorHandler(`load module failed due to "${loadReply.errorReason}"`);
      return;
    }
    await this.runCode(proto.RunCodeType.START);

    this.sendEvent(new StoppedEvent("entry", DebugSession.threadID));
    this.sendResponse(response);
  }
  protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
    await this.runCode(proto.RunCodeType.STEP);
    this.sendEvent(new StoppedEvent("step", DebugSession.threadID));
    this.sendResponse(response);
  }
  protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
    await this.runCode(proto.RunCodeType.STEP_OUT);
    this.sendEvent(new StoppedEvent("step", DebugSession.threadID));
    this.sendResponse(response);
  }
  protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
    await this.runCode(proto.RunCodeType.STEP_OVER);
    this.sendEvent(new StoppedEvent("step", DebugSession.threadID));
    this.sendResponse(response);
  }

  private async runCode(type: proto.RunCodeType) {
    let reply = await new Promise<proto.RunCodeReply.AsObject>((resolve) => {
      this._client.runCode(new proto.RunCodeRequest().setRunCodeType(type), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err}`);
        }
        resolve(reply.toObject());
      });
    });
    if (reply && reply.status == proto.Status.NOK) {
      this.errorHandler(`excute failed due to: ${reply.errorReason}`);
      return false;
    }
  }

  // ██      ██ ███████ ████████ ███████ ███    ██
  // ██      ██ ██         ██    ██      ████   ██
  // ██      ██ ███████    ██    █████   ██ ██  ██
  // ██      ██      ██    ██    ██      ██  ██ ██
  // ███████ ██ ███████    ██    ███████ ██   ████

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // runtime supports no threads so just return a default thread.
    response.body = {
      threads: [new Thread(DebugSession.threadID, "default thread")],
    };
    this.sendResponse(response);
  }
  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
    let reply = await new Promise<proto.GetCallStackReply.AsObject>((resolve) => {
      this._client.getCallStack(new proto.GetCallStackRequest(), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err}`);
        }
        resolve(reply.toObject());
      });
    });
    if (reply.status == proto.Status.NOK) {
      this.errorHandler(`get stack failed due to "${reply.errorReason}"`);
      return;
    }
    assert(this._sourceMapAnalysis);
    const binaryToSourceMapping = await this._sourceMapAnalysis.binaryToSourceMapping;
    const ast = await this._sourceMapAnalysis.ast;
    if (binaryToSourceMapping) {
      let instrTobinaryMapping = await this._sourceMapAnalysis.instrToBinaryMapping;
      response.body = {
        stackFrames: reply.stacksList.map((stack, index, arr) => {
          let sourcePosition: SourcePosition | undefined = undefined;
          let instrIndex = stack.instrIndex;
          for (; instrIndex >= 0; instrIndex--) {
            if (stack.funcIndex >= instrTobinaryMapping.length) {
              break;
            }
            const functionInstr = instrTobinaryMapping[stack.funcIndex];
            if (instrIndex >= functionInstr.length) {
              instrIndex = functionInstr.length;
              continue;
            }
            let binaryOffset = functionInstr[instrIndex];
            if (binaryOffset) {
              sourcePosition = binaryToSourceMapping.get(binaryOffset);
              if (sourcePosition) {
                break;
              }
            }
          }
          if (sourcePosition) {
            if (index == 0 && instrIndex != stack.instrIndex) {
              vscode.window.showInformationMessage(
                `stack trace may be incorrect, miss ${stack.instrIndex - instrIndex} instruction`
              );
            }
            return new StackFrame(
              index,
              ast.functionName[stack.funcIndex] ?? stack.funcIndex.toString(),
              this.createSource(sourcePosition.source),
              sourcePosition.line
            );
          } else {
            return new StackFrame(index, ast.functionName[stack.funcIndex] ?? stack.funcIndex.toString());
          }
        }),
      };
    } else {
      response.body = {
        stackFrames: reply.stacksList.map((stack, index) => new StackFrame(index, stack.funcIndex.toString())),
      };
    }
    this.sendResponse(response);
  }
  protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    response.body = {
      scopes: [
        new Scope(`Locals`, ScopeId.getStackId(args.frameId), false),
        new Scope("ValueStack", ScopeId.getValueStackId(), false),
        new Scope("Globals", ScopeId.getGlobalId(), false),
      ],
    };
    this.sendResponse(response);
  }
  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
    request?: DebugProtocol.Request
  ): Promise<void> {
    let valueList: { name?: string; value?: proto.Value }[] = [];
    let ast = await this._sourceMapAnalysis?.ast;
    assert(ast);
    switch (args.variablesReference) {
      case FixedScopeId.Global: {
        return;
        break;
      }
      case FixedScopeId.ValueStack: {
        let reply = await new Promise<proto.GetValueStackReply>((resolve) => {
          this._client.getValueStack(new proto.NullRequest(), (err, reply) => {
            if (err) {
              this.errorHandler(`connect with debug server failed: ${err}`);
            }
            resolve(reply);
          });
        });
        if (reply.getStatus() == proto.Status.NOK) {
          this.errorHandler(`get value stack failed due to "${reply.getErrorReason()}"`);
          return;
        }
        valueList = reply.getValuesList().map((values) => {
          return { value: values };
        });
        break;
      }
      default: {
        let stackFrame = -1 - ScopeId.getStack(args.variablesReference);
        let reply = await new Promise<proto.GetLocalReply>((resolve) => {
          this._client.getLocal(new proto.GetLocalRequest().setCallStack(stackFrame), (err, reply) => {
            if (err) {
              this.errorHandler(`connect with debug server failed: ${err}`);
            }
            resolve(reply);
          });
        });
        if (reply.getStatus() == proto.Status.NOK) {
          this.errorHandler(`get local failed due to "${reply.getErrorReason()}"`);
          return;
        }
        let localName: Array<string | undefined> | undefined = undefined;
        let funcIndex = reply.getFuncIndex();
        if (funcIndex != undefined) {
          localName = ast.localName[funcIndex];
        }
        valueList = reply.getLocalsList().map((locals, index) => {
          let name = localName ? localName[index] : undefined;
          return { name, value: locals };
        });
        break;
      }
    }
    response.body = {
      variables: valueList.map((valueProp, index) => {
        let value = valueProp.value;
        let variable: DebugProtocol.Variable = {
          name: valueProp.name ?? `${index}`,
          value: DebugSession.value2str(value),
          variablesReference: 0,
        };
        return variable;
      }),
    };
    this.sendResponse(response);
  }

  // ██   ██ ███████ ██      ██████  ███████ ██████
  // ██   ██ ██      ██      ██   ██ ██      ██   ██
  // ███████ █████   ██      ██████  █████   ██████
  // ██   ██ ██      ██      ██      ██      ██   ██
  // ██   ██ ███████ ███████ ██      ███████ ██   ██

  private createSource(filePath: string): Source {
    return new Source(
      basename(filePath),
      this.convertDebuggerPathToClient(filePath),
      undefined,
      undefined,
      "assemblyscript-debug-adapter-data"
    );
  }

  private errorHandler(reason: string) {
    vscode.window.showErrorMessage(reason);
    this.sendEvent(new TerminatedEvent());
  }

  private static value2str(value: proto.Value | undefined): string {
    if (value == undefined) {
      return "unknown";
    }
    switch (value.getValueCase()) {
      case proto.Value.ValueCase.I32: {
        return value.getI32().toString();
      }
      case proto.Value.ValueCase.I64: {
        return value.getI64().toString();
      }
      case proto.Value.ValueCase.F32: {
        return value.getF32().toString();
      }
      case proto.Value.ValueCase.F64: {
        return value.getF64().toString();
      }
    }
    return "unknown";
  }
}
