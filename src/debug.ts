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
  Breakpoint,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { WasmDebuggerClient } from "./proto/interface_grpc_pb";
import * as grpc from "@grpc/grpc-js";
import * as proto from "./proto/interface_pb";
import { basename } from "path";
import { instr2source, SourceMapAnalysis } from "./sourceMap";
import assert = require("assert");
import { FixedScopeId, ScopeId } from "./scopeId";
import { WasmDAPServer } from "./dapServer";
import { sleep, value2str } from "./utils";
import { abort, trace } from "./importFunction";
import { DebugSessionWrapper } from "./debugSession";
import { BreakpointManager } from "./breakpointManager";
import { logInfo } from "./channel";

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

enum Status {
  INIT,
  FREE,
  STARTING,
  RUNNING,
  FINISH,
}

export class DebugSession extends LoggingDebugSession {
  private static threadID = 1;

  private _client: WasmDebuggerClient;
  private _server: WasmDAPServer;
  private _sourceMapAnalysis: SourceMapAnalysis | null = null;
  private _breakpointManager: BreakpointManager | null = null;
  private _status: Status = Status.INIT;

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
    this._status = Status.FREE;
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
    request?: DebugProtocol.Request
  ): void {
    logInfo(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
    this._status = Status.INIT;
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
    // wait 1 second * 10 times until configuration has finished (and configurationDoneRequest has been called)
    let retryTime = 5;
    const waitTime = 1000;
    for (; retryTime > 0; retryTime--) {
      if (this._status != Status.INIT) {
        break;
      }
      await sleep(waitTime);
    }
    if (retryTime == 0) {
      this.errorHandler("configuration failed");
      return;
    }
    this._status = Status.STARTING;
    // start server
    this._server.ast = await this._sourceMapAnalysis.ast;
    this._server.start();
    // load module
    const loadReply = await new Promise<proto.NormalReply>((resolve) => {
      this._client.loadModule(new proto.LoadRequest().setFileName(args.program), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
        }
        resolve(reply);
      });
    });
    if (loadReply.getStatus() == proto.Status.NOK) {
      this.errorHandler(`load module failed due to "${loadReply.getErrorReason()}"`);
      return;
    }
    this._status = Status.RUNNING;
    const breakpointManager = await this.checkBreakpointManager();
    if (breakpointManager) {
      await breakpointManager.syncBreakpoints();
    }
    await this.runCode(proto.RunCodeType.START);

    this.sendEvent(new StoppedEvent("entry", DebugSession.threadID));
    this.sendResponse(response);
  }
  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments,
    request?: DebugProtocol.Request | undefined
  ) {
    await this.runCode(proto.RunCodeType.CONTINUE);
    this.sendEvent(new StoppedEvent("step", DebugSession.threadID));
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
    const reply = await new Promise<proto.RunCodeReply>((resolve) => {
      this._client.runCode(new proto.RunCodeRequest().setRunCodeType(type), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
        }
        resolve(reply);
      });
    });
    switch (reply.getStatus()) {
      case proto.Status.OK:
        break;
      case proto.Status.NOK:
        this.errorHandler(`execute failed due to: ${reply.getErrorReason()}`);
        break;
      case proto.Status.FINISH:
        this.sendEvent(new OutputEvent("execute finish.\n", "console"));
        this.sendEvent(new TerminatedEvent());
        this._status = Status.FINISH;
        break;
    }
  }

  // ██████  ██████  ███████  █████  ██   ██ ██████   ██████  ██ ███    ██ ████████
  // ██   ██ ██   ██ ██      ██   ██ ██  ██  ██   ██ ██    ██ ██ ████   ██    ██
  // ██████  ██████  █████   ███████ █████   ██████  ██    ██ ██ ██ ██  ██    ██
  // ██   ██ ██   ██ ██      ██   ██ ██  ██  ██      ██    ██ ██ ██  ██ ██    ██
  // ██████  ██   ██ ███████ ██   ██ ██   ██ ██       ██████  ██ ██   ████    ██

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    await (async () => {
      const breakpointManager = await this.checkBreakpointManager();
      const targetBreakpoint = args.breakpoints;
      if (targetBreakpoint == undefined) {
        return;
      }
      const path = args.source.path as string;
      const source = new Source(args.source.name ?? path, path, undefined, args.source.origin, args.source.adapterData);
      if (breakpointManager == null) {
        return;
      }
      const actualBreakpointMap = await breakpointManager.updataBreakpoints(
        path,
        targetBreakpoint.map((bp) => bp.line),
        this._status == Status.RUNNING // if running, breakpoint should be set immediately
      );
      response.body = {
        breakpoints: targetBreakpoint.map((bp) => {
          const bpIndex = actualBreakpointMap.get(bp.line);
          return new Breakpoint(bpIndex != undefined, bp.line, undefined, source);
        }),
      };
    })();
    this.sendResponse(response);
  }

  private async checkBreakpointManager() {
    if (this._breakpointManager == null) {
      assert(this._sourceMapAnalysis);
      const sourceToInstrMapping = await this._sourceMapAnalysis.sourceToInstrMapping;
      if (sourceToInstrMapping == null) {
        return null;
      }
      this._breakpointManager = new BreakpointManager(this._client, sourceToInstrMapping, this.errorHandler);
    }
    return this._breakpointManager;
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
    if (this._status == Status.FINISH) {
      this.sendResponse(response);
      return;
    }
    const reply = await new Promise<proto.GetCallStackReply>((resolve) => {
      this._client.getCallStack(new proto.NullRequest(), (err, reply) => {
        if (err) {
          this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
        }
        resolve(reply);
      });
    });
    if (reply.getStatus() == proto.Status.NOK) {
      this.errorHandler(`get stack failed due to "${reply.getErrorReason()}"`);
      return;
    }
    assert(this._sourceMapAnalysis);
    const binaryToSourceMapping = await this._sourceMapAnalysis.binaryToSourceMapping;
    const ast = await this._sourceMapAnalysis.ast;
    if (binaryToSourceMapping) {
      const instrTobinaryMapping = await this._sourceMapAnalysis.instrToBinaryMapping;
      response.body = {
        stackFrames: reply.getStacksList().map((stack, index, arr) => {
          let instrIndex = stack.getInstrIndex();
          const funcIndex = stack.getFuncIndex();
          if (index != 0) {
            // if not in top call stack, instr is return addr, so need to reduce 1 for call instr
            instrIndex--;
          }
          const sourcePosition = instr2source(
            { funcIndex, instrIndex },
            instrTobinaryMapping,
            binaryToSourceMapping,
            (delta) => {
              if (index == 0) {
                void vscode.window.showInformationMessage(`stack trace may be incorrect, miss ${delta} instruction`);
              }
            }
          );
          if (sourcePosition) {
            return new StackFrame(
              index,
              ast.functionName[funcIndex] ?? funcIndex.toString(),
              this.createSource(sourcePosition.source),
              sourcePosition.line
            );
          } else {
            return new StackFrame(index, ast.functionName[funcIndex] ?? funcIndex.toString());
          }
        }),
      };
    } else {
      response.body = {
        stackFrames: reply.getStacksList().map((stack, index) => new StackFrame(index, stack.getFuncIndex().toString())),
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
    _request?: DebugProtocol.Request
  ): Promise<void> {
    if (this._status == Status.FINISH) {
      this.sendResponse(response);
      return;
    }
    let valueList: { name?: string; value?: proto.Value }[] = [];
    const ast = await this._sourceMapAnalysis?.ast;
    assert(ast);
    switch (args.variablesReference) {
      case FixedScopeId.Global: {
        const reply = await new Promise<proto.GetGlobalReply>((resolve) => {
          this._client.getGlobal(new proto.NullRequest(), (err, reply) => {
            if (err) {
              this.errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
            }
            resolve(reply);
          });
        });
        if (reply.getStatus() == proto.Status.NOK) {
          this.errorHandler(`get global stack failed due to "${reply.getErrorReason()}"`);
          return;
        }
        valueList = reply.getGlobalsList().map((value, index) => {
          return { name: ast.globalName[index], value };
        });
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
        valueList = reply.getValuesList().map((value) => {
          return { value };
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
        valueList = reply.getLocalsList().map((value, index) => {
          const name = localName ? localName[index] : undefined;
          return { name, value };
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
    this._status = Status.FREE;
    void vscode.window.showErrorMessage(reason);
    const e = new OutputEvent(reason, "stderr");
    this.sendEvent(e);
    this.sendEvent(new TerminatedEvent());
  };
}
