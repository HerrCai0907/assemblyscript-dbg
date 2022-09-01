import * as grpc from "@grpc/grpc-js";
import assert = require("assert");
import { logInfo } from "./channel";
import { IMPORT_FUNC_DEBUG } from "./constant";
import { IWasmDAPServer, WasmDAPService } from "./proto/interface_grpc_pb";
import * as proto from "./proto/interface_pb";
import { number2value, updateValue, value2number } from "./utils";
import { WasmAst } from "./wasmParser";

class _WasmDAPServer implements IWasmDAPServer {
  [name: string]: grpc.UntypedHandleCall;
  constructor(public runImportFunction: grpc.handleUnaryCall<proto.RunImportFunctionRequest, proto.RunImportFunctionReply>) {}
}

export type ImportFunction = (args: number[], memory: Uint8Array, globals: number[]) => number | null;

export class WasmDAPServer {
  private _serverInstance: _WasmDAPServer | null = null;
  private _server: grpc.Server | null = null;
  private _importFunction: Record<string, Record<string, ImportFunction | undefined> | undefined> = {};
  constructor(private port: string, private errorHandler: (reason: string) => void) {}

  set ast(ast: WasmAst) {
    this._serverInstance = new _WasmDAPServer(
      (
        call: grpc.ServerUnaryCall<proto.RunImportFunctionRequest, proto.RunImportFunctionReply>,
        callback: grpc.sendUnaryData<proto.RunImportFunctionReply>
      ) => {
        const req = call.request;
        const funcIndex = req.getFuncIndex();
        const args = req.getArgsList().map(value2number);
        const memory = req.getMemory_asU8();
        const globals = req.getGlobalsList();
        const globalNumber = globals.map(value2number);
        const importFunctionName = ast.importFunctionName.get(funcIndex);
        assert(importFunctionName);
        const [moduleName, fieldName] = importFunctionName;
        if (IMPORT_FUNC_DEBUG) logInfo(`call import function "${moduleName}.${fieldName}"`);
        let func: ImportFunction | undefined = undefined;
        const module = this._importFunction[moduleName];
        if (module) {
          func = module[fieldName];
        }
        if (func == undefined) {
          this.errorHandler(`no import function "${moduleName}.${fieldName}"`);
          return;
        }
        const ret = func(args, memory, globalNumber);
        const reply = new proto.RunImportFunctionReply();
        reply.setMemory(memory);
        globals.forEach((global, index) => {
          updateValue(global, globalNumber[index]);
        });
        reply.setGlobalsList(globals);
        if (ret != null) {
          reply.setReturnValue(number2value(ret, proto.Value.ValueCase.I32));
        }
        callback(null, reply, undefined, undefined);
      }
    );
  }

  registeryImportFunction(moduleName: string, fieldName: string, importFunction: ImportFunction) {
    const module = this._importFunction[moduleName] ?? {};
    module[fieldName] = importFunction;
    this._importFunction[moduleName] = module;
  }

  start() {
    assert(this._serverInstance);
    if (this._server) {
      this._server.forceShutdown();
    }
    this._server = new grpc.Server();
    this._server.addService(WasmDAPService, this._serverInstance);
    this._server.bindAsync(this.port, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        this.errorHandler(`start debug server in ${port} failed due to ${err.message}`);
      } else {
        if (this._server) {
          this._server.start();
        }
      }
    });
  }

  stop() {
    if (this._server) {
      this._server.tryShutdown((err) => {
        if (err && this._server) {
          this._server.forceShutdown();
        }
        this._server = null;
      });
    }
  }
}
