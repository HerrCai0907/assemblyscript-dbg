import { logInfo } from "./channel";
import { BREAKPOINT_DEBUG } from "./constant";
import { WasmDebuggerClient } from "./proto/interface_grpc_pb";
import * as proto from "./proto/interface_pb";
import { source2instr } from "./sourceMap";

type FilePath = string;
type Line = number;
type BreakpointIndex = number;
type FuncBreakpointIndex = () => Promise<BreakpointIndex | undefined>;
type LineMap = Map<Line, (BreakpointIndex | FuncBreakpointIndex)[]>;

export class BreakpointManager {
  breakpoints: Map<FilePath, LineMap> = new Map();
  constructor(
    private _client: WasmDebuggerClient,
    private _sourceToInstrMapping: Map<FilePath, Map<Line, { funcIndex: number; instrIndex: number }[]>>,
    private _errorHandler: (reason: string) => void
  ) {}

  async syncBreakpoints() {
    for (const [_, lineMap] of this.breakpoints) {
      for (const [line, bpIndexs] of lineMap) {
        const newBreakpointIndexs: BreakpointIndex[] = [];
        for (let i = 0; i < bpIndexs.length; i++) {
          const bpIndex = bpIndexs[i];
          if (typeof bpIndex == "function") {
            const updatedIndex = await bpIndex();
            if (updatedIndex != undefined) {
              newBreakpointIndexs.push(updatedIndex);
            }
          } else {
            newBreakpointIndexs.push(bpIndex);
          }
        }
        lineMap.set(line, newBreakpointIndexs);
      }
    }
  }

  async updataBreakpoints(path: FilePath, lines: Line[], updateImmediate: boolean): Promise<LineMap> {
    const oldLines = this.breakpoints.get(path);
    const newLines: LineMap = new Map();
    const linesSet = new Set(lines);
    if (oldLines) {
      // update old breakpoints
      for (const [line, breakpointIndexs] of oldLines) {
        if (linesSet.has(line)) {
          // both in new and old
          newLines.set(line, breakpointIndexs);
          linesSet.delete(line);
        } else {
          // only in old
          await Promise.all(
            breakpointIndexs.map(async (breakpointIndex, index) => {
              if (typeof breakpointIndex == "number") {
                if (updateImmediate) {
                  await this.removeBreakpoint(breakpointIndex);
                } else {
                  if (BREAKPOINT_DEBUG) logInfo(`cache remove bp ${breakpointIndex}`);
                  breakpointIndexs[index] = async () => {
                    this.removeBreakpoint(breakpointIndex);
                    return undefined;
                  };
                }
              }
            })
          );
        }
      }
    }
    // update new breakpoints
    for (let line of linesSet) {
      const codePositions = source2instr({ source: path, line }, this._sourceToInstrMapping);
      if (codePositions.length == 0) {
        continue;
      }
      if (updateImmediate) {
        // communicate with server immediately
        const breakpointIndexs: BreakpointIndex[] = [];
        for (const codePosition of codePositions) {
          const breakpointIndex = await this.addBreakpoint(codePosition.funcIndex, codePosition.instrIndex);
          if (breakpointIndex != undefined) {
            breakpointIndexs.push(breakpointIndex);
          }
        }
        if (breakpointIndexs.length != 0) {
          newLines.set(line, breakpointIndexs);
        }
      } else {
        // store the notify call
        if (BREAKPOINT_DEBUG) logInfo(`cache set bp ${JSON.stringify(codePositions)}`);
        newLines.set(
          line,
          codePositions.map((codePosition) => () => this.addBreakpoint(codePosition.funcIndex, codePosition.instrIndex))
        );
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
    if (BREAKPOINT_DEBUG) logInfo(`set bp (${funcIndex},${instrIndex}), index ${breakpointIndex}`);
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
      return;
    }
    if (BREAKPOINT_DEBUG) logInfo(`remove bp index ${breakpointIndex}`);
  }
}
