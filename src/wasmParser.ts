import * as wasmparser from "wasmparser";

export interface WasmAst {
  sourceMapUrl: string | null;
  instructionMap: number[][];
}

export function wasmParser(buf: Uint8Array): WasmAst {
  let result: WasmAst = { instructionMap: [], sourceMapUrl: null };
  let currentFunction: number[] = [];
  let parser = new wasmparser.BinaryReader();
  parser.setData(buf.buffer, 0, buf.length);
  while (parser.state >= 0) {
    if (!parser.read()) return result;
    switch (parser.state) {
      case wasmparser.BinaryReaderState.BEGIN_FUNCTION_BODY:
        currentFunction = [];
        break;
      case wasmparser.BinaryReaderState.END_FUNCTION_BODY:
        result.instructionMap.push(currentFunction);
        break;
      case wasmparser.BinaryReaderState.CODE_OPERATOR: {
        let pos = parser.position;
        currentFunction.push(pos);
        break;
      }
      case wasmparser.BinaryReaderState.SOURCE_MAPPING_URL:
        let sectionInfo = parser.result as wasmparser.ISourceMappingURL;
        result.sourceMapUrl = Buffer.from(sectionInfo.url).toString("utf8");
        break;
    }
  }
  return result;
}
