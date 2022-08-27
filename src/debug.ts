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
  OutputEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { WasmDebuggerClient } from "./proto/interface_grpc_pb";
import * as grpc from "@grpc/grpc-js";
import * as proto from "./proto/interface_pb";
import { basename } from "path";
import { SourceMapAnalysis, SourcePosition } from "./sourceMap";
import assert = require("assert");
import { FixedScopeId, ScopeId } from "./scopeId";
import { WasmDAPServer } from "./dapServer";
import { value2str } from "./utils";
import { abort, trace } from "./importFunction";
import { DebugSessionWrapper } from "./debugSession";

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
  /** List of user-defined API */
  apiFiles?: string[];
}
type ApiCollection = Record<
  string,
  | Record<
      string,
      ((extension: DebugSessionWrapper, args: number[], memory: Uint8Array, globals: number[]) => number | null) | undefined
    >
  | undefined
>;

export class DebugSession extends LoggingDebugSession {
  private static threadID = 1;

  private _configurationDone = false;
  private _client: WasmDebuggerClient;
  private _server: WasmDAPServer;
  private _sourceMapAnalysis: SourceMapAnalysis | null = null;

  constructor(debuggerPort: number, dapPort: number) {
    super("assemblyscript-debugger.txt");
    // this debugger uses zero-based lines and columns
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this._client = new WasmDebuggerClient(`[::1]:${debuggerPort}`, grpc.credentials.createInsecure());
    this._server = new WasmDAPServer(`127.0.0.1:${dapPort}`, this.errorHandler);
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
    response.body = response.body ?? {};
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

  dispose() {
    this._server.stop();
  }

  //  ██████  ██████  ███████ ██████   █████  ████████  ██████  ██████
  // ██    ██ ██   ██ ██      ██   ██ ██   ██    ██    ██    ██ ██   ██
  // ██    ██ ██████  █████   ██████  ███████    ██    ██    ██ ██████
  // ██    ██ ██      ██      ██   ██ ██   ██    ██    ██    ██ ██   ██
  //  ██████  ██      ███████ ██   ██ ██   ██    ██     ██████  ██   ██

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    this._sourceMapAnalysis = new SourceMapAnalysis(args.program, args.cwd);
    // register default API
    this._server.registeryImportFunction("env", "trace", (args: number[], memory: Uint8Array) => {
      try {
        return trace(new DebugSessionWrapper(this), args, memory);
      } catch (e) {
        this.sendEvent(new OutputEvent(`user defined function crash due to ${e}`, "stderr"));
        this.sendEvent(new StoppedEvent("exception"));
        return null;
      }
    });
    this._server.registeryImportFunction("env", "abort", (args: number[], memory: Uint8Array) => {
      try {
        return abort(new DebugSessionWrapper(this), args, memory);
      } catch (e) {
        this.sendEvent(new OutputEvent(`user defined function crash due to ${e}`, "stderr"));
        this.sendEvent(new StoppedEvent("exception"));
        return null;
      }
    });
    // register user defined API
    args.apiFiles?.forEach((file) => {
      const apis = require(file) as ApiCollection;
      for (const moduleName in apis) {
        const module = apis[moduleName];
        assert(module);
        for (const fieldName in module) {
          const field = module[fieldName];
          assert(field);
          this._server.registeryImportFunction(
            moduleName,
            fieldName,
            (args: number[], memory: Uint8Array, globals: number[]) => {
              try {
                return field(new DebugSessionWrapper(this), args, memory, globals);
              } catch (e) {
                this.sendEvent(new OutputEvent(`user defined function crash due to ${e}`, "stderr"));
                this.sendEvent(new StoppedEvent("exception"));
                return null;
              }
            }
          );
        }
      }
    });
    // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
    const available = await new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(this._configurationDone);
      }, 1000);
    });
    if (!available) {
      this.errorHandler("configuration failed");
      return;
    }
    // start server
    this._server.ast = await this._sourceMapAnalysis.ast;
    this._server.start();
    // load module
    const loadReply = await new Promise<proto.LoadReply.AsObject>((resolve) => {
      this._client.loadModule(new proto.LoadRequest().setFileName(args.program), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
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
    const reply = await new Promise<proto.RunCodeReply.AsObject>((resolve) => {
      this._client.runCode(new proto.RunCodeRequest().setRunCodeType(type), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
        }
        resolve(reply.toObject());
      });
    });
    if (reply.status == proto.Status.NOK) {
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
    const reply = await new Promise<proto.GetCallStackReply.AsObject>((resolve) => {
      this._client.getCallStack(new proto.GetCallStackRequest(), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
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
      const instrTobinaryMapping = await this._sourceMapAnalysis.instrToBinaryMapping;
      response.body = {
        stackFrames: reply.stacksList.map((stack, index, arr) => {
          let sourcePosition: SourcePosition | undefined = undefined;
          let instrIndex = stack.instrIndex;
          if (index != 0) {
            // if not in top call stack, instr is return addr, so need to reduce 1 for call instr
            instrIndex--;
          }
          const orginInstrIndex = instrIndex;
          for (; instrIndex >= 0; instrIndex--) {
            if (stack.funcIndex >= instrTobinaryMapping.length) {
              break;
            }
            const functionInstr = instrTobinaryMapping[stack.funcIndex];
            if (instrIndex >= functionInstr.length) {
              instrIndex = functionInstr.length;
              continue;
            }
            const binaryOffset = functionInstr[instrIndex];
            if (binaryOffset) {
              sourcePosition = binaryToSourceMapping.get(binaryOffset);
              if (sourcePosition) {
                break;
              }
            }
          }
          if (sourcePosition) {
            if (index == 0 && instrIndex != orginInstrIndex) {
              void vscode.window.showInformationMessage(
                `stack trace may be incorrect, miss ${orginInstrIndex - instrIndex} instruction`
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
    const ast = await this._sourceMapAnalysis?.ast;
    assert(ast);
    switch (args.variablesReference) {
      case FixedScopeId.Global: {
        // TODO
        return;
        break;
      }
      case FixedScopeId.ValueStack: {
        const reply = await new Promise<proto.GetValueStackReply>((resolve) => {
          this._client.getValueStack(new proto.NullRequest(), (err, reply) => {
            if (err) {
              this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
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
        const stackFrame = -1 - ScopeId.getStack(args.variablesReference);
        const reply = await new Promise<proto.GetLocalReply>((resolve) => {
          this._client.getLocal(new proto.GetLocalRequest().setCallStack(stackFrame), (err, reply) => {
            if (err) {
              this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
            }
            resolve(reply);
          });
        });
        if (reply.getStatus() == proto.Status.NOK) {
          this.errorHandler(`get local failed due to "${reply.getErrorReason()}"`);
          return;
        }
        let localName: (string | undefined)[] | undefined = undefined;
        const funcIndex = reply.getFuncIndex();
        if (funcIndex != undefined) {
          localName = ast.localName[funcIndex];
        }
        valueList = reply.getLocalsList().map((locals, index) => {
          const name = localName ? localName[index] : undefined;
          return { name, value: locals };
        });
        break;
      }
    }
    response.body = {
      variables: valueList.map((valueProp, index) => {
        const value = valueProp.value;
        const variable: DebugProtocol.Variable = {
          name: valueProp.name ?? `${index}`,
          value: value2str(value),
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

  private errorHandler = (reason: string) => {
    void vscode.window.showErrorMessage(reason);
    const e = new OutputEvent(reason, "stderr");
    this.sendEvent(e);
    this.sendEvent(new TerminatedEvent());
  };
}
