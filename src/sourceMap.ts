import { promises } from "fs";
import { RawSourceMap, SourceMapConsumer } from "source-map";
import { dirname, join, relative } from "path";
import { wasmParser, WasmAst } from "./wasmParser";
const readFile = promises.readFile;

export interface SourcePosition {
  source: string;
  line: number;
}

type CodeOffset = number;
type FunctionInstr = CodeOffset[];

export class SourceMapAnalysis {
  rawBuffer: Promise<Buffer>;
  ast: Promise<WasmAst>;
  binaryToSourceMapping: Promise<Map<CodeOffset, SourcePosition> | null>;
  instrToBinaryMapping: Promise<FunctionInstr[]>;

  constructor(wasmFilePath: string, workSpacePath: string) {
    this.rawBuffer = readFile(wasmFilePath);
    this.ast = this.rawBuffer.then((buf) => {
      return wasmParser(buf);
    });
    this.binaryToSourceMapping = this.ast.then(async (ast) => {
      if (ast.sourceMapUrl == null) {
        return null;
      }
      let sourceMapUrl = join(dirname(wasmFilePath), ast.sourceMapUrl);
      const sourceMap: RawSourceMap = JSON.parse(await readFile(sourceMapUrl, { encoding: "utf8" }));
      return SourceMapConsumer.with(sourceMap, null, (consumer) => {
        let binaryToSourceMapping = new Map();
        consumer.eachMapping((m) => {
          let source = sourceMap.sourceRoot ? relative(sourceMap.sourceRoot, m.source) : m.source;
          source = source.replace(/^~lib/, "node_modules/assemblyscript/std/assembly");
          source = join(workSpacePath, source);
          binaryToSourceMapping.set(m.generatedColumn, { source, line: m.originalLine });
        });
        return binaryToSourceMapping;
      });
    });
    this.instrToBinaryMapping = this.ast.then((ast) => ast.instructionMap);
  }
}
