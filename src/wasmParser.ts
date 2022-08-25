import assert = require("assert");
import * as wasmparser from "wasmparser";

export interface WasmAst {
  sourceMapUrl: string | null;
  instructionMap: number[][];
  functionName: Array<string | undefined>;
  localName: Array<Array<string | undefined> | undefined>;
  importFunctionName: Map<number, [string, string]>;
}

function bytes2str(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("utf8");
}

export function wasmParser(buf: Uint8Array): WasmAst {
  let result: WasmAst = {
    instructionMap: [],
    sourceMapUrl: null,
    functionName: [],
    localName: [],
    importFunctionName: new Map(),
  };
  let currentFunction: number[] = [];
  let parser = new wasmparser.BinaryReader();
  parser.setData(buf.buffer, 0, buf.length);
  while (parser.state >= 0) {
    if (!parser.read()) return result;
    switch (parser.state) {
      case wasmparser.BinaryReaderState.IMPORT_SECTION_ENTRY: {
        const importEntry = parser.result as wasmparser.IImportEntry;
        const kind = importEntry.kind;
        switch (kind) {
          case wasmparser.ExternalKind.Function: {
            result.importFunctionName.set(result.instructionMap.length, [
              bytes2str(importEntry.module),
              bytes2str(importEntry.field),
            ]);
            result.instructionMap.push([]);
            break;
          }
        }
        break;
      }
      case wasmparser.BinaryReaderState.BEGIN_FUNCTION_BODY: {
        // function body means first opcode
        currentFunction = [parser.position];
        break;
      }
      case wasmparser.BinaryReaderState.END_FUNCTION_BODY: {
        result.instructionMap.push(currentFunction);
        break;
      }
      case wasmparser.BinaryReaderState.CODE_OPERATOR: {
        currentFunction.push(parser.position);
        break;
      }
      case wasmparser.BinaryReaderState.NAME_SECTION_ENTRY: {
        let nameSection = parser.result as wasmparser.INameEntry;
        switch (nameSection.type) {
          case wasmparser.NameType.Function: {
            result.functionName ??= [];
            for (const funcName of (nameSection as wasmparser.IFunctionNameEntry).names) {
              result.functionName[funcName.index] = bytes2str(funcName.name);
            }
            break;
          }
          case wasmparser.NameType.Local: {
            let localNames = nameSection as wasmparser.ILocalNameEntry;
            localNames.funcs.forEach((func) => {
              let funcLocalNames: string[] = [];
              func.locals.forEach((local) => {
                funcLocalNames[local.index] = bytes2str(local.name);
              });
              result.localName[func.index] = funcLocalNames;
            });
          }
        }
        break;
      }
      case wasmparser.BinaryReaderState.SOURCE_MAPPING_URL: {
        let sectionInfo = parser.result as wasmparser.ISourceMappingURL;
        result.sourceMapUrl = bytes2str(sectionInfo.url);
        break;
      }
    }
  }
  return result;
}
