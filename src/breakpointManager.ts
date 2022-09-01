import { WasmDebuggerClient } from "./proto/interface_grpc_pb";
import * as proto from "./proto/interface_pb";
import { source2instr } from "./sourceMap";

type FilePath = string;
type Line = number;
type BreakpointIndex = number;

export class BreakpointManager {
  breakpoints: Map<FilePath, Map<Line, BreakpointIndex>> = new Map();
  constructor(
    private _client: WasmDebuggerClient,
    private _sourceToInstrMapping: Map<FilePath, Map<Line, { funcIndex: number; instrIndex: number }>>,
    private _errorHandler: (reason: string) => void
  ) {}

  async updataBreakpoints(path: FilePath, lines: Line[]): Promise<Map<Line, BreakpointIndex>> {
    const oldLines = this.breakpoints.get(path);
    const newLines = new Map<Line, BreakpointIndex>();
    if (oldLines == undefined) {
      for (let line of lines) {
        const codePosition = source2instr({ source: path, line }, this._sourceToInstrMapping);
        if (codePosition == null) {
          continue;
        }
        const breakpointIndex = await this.addBreakpoint(codePosition.funcIndex, codePosition.instrIndex);
        if (breakpointIndex) {
          newLines.set(line, breakpointIndex);
        }
      }
    } else {
      const linesSet = new Set(lines);
      // update old breakpoints
      for (const [line, breakpointIndex] of oldLines) {
        if (linesSet.has(line)) {
          newLines.set(line, breakpointIndex);
          linesSet.delete(line);
        } else {
          await this.removeBreakpoint(breakpointIndex);
        }
      }
      // update new breakpoints
      for (let line of linesSet) {
        const codePosition = source2instr({ source: path, line: line }, this._sourceToInstrMapping);
        if (codePosition == null) {
          continue;
        }
        const breakpointIndex = await this.addBreakpoint(codePosition.funcIndex, codePosition.instrIndex);
        if (breakpointIndex != undefined) {
          newLines.set(line, breakpointIndex);
        }
      }
    }
    this.breakpoints.set(path, newLines);
    return newLines;
  }

  private async addBreakpoint(funcIndex: number, instrIndex: number) {
    const reply = await new Promise<proto.AddBreakpointReply>((resolve) => {
      this._client.addBreakpoint(
        new proto.CodePosition().setFuncIndex(funcIndex).setInstrIndex(instrIndex),
        (err, response) => {
          if (err) {
            this._errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
          }
          resolve(response);
        }
      );
    });
    if (reply.getStatus() == proto.Status.NOK) {
      this._errorHandler(`set breakpoint failed due to "${reply.getErrorReason()}"`);
      return;
    }
    const breakpointIndex = reply.getBreakpointIndex();
    return breakpointIndex;
  }

  private async removeBreakpoint(breakpointIndex: number) {
    const reply = await new Promise<proto.NormalReply>((resolve) => {
      this._client.deleteBreakpoint(
        new proto.DeleteBreakpointRequest().setBreakpointIndex(breakpointIndex),
        (err, response) => {
          if (err) {
            this._errorHandler(`connect with debug server failed: ${err.name} ${err.details}`);
          }
          resolve(response);
        }
      );
    });
    if (reply.getStatus() == proto.Status.NOK) {
      this._errorHandler(`set breakpoint failed due to "${reply.getErrorReason()}"`);
    }
  }
}
