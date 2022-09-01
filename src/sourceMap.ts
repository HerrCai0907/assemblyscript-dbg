import { promises } from "fs";
import { RawSourceMap, SourceMapConsumer } from "source-map";
import { dirname, join, relative } from "path";
import { wasmParser, WasmAst } from "./wasmParser";
import assert = require("assert");
const readFile = promises.readFile;

type BinaryOffset = number;
type FunctionInstr = BinaryOffset[];
type FilePath = string;
type Line = number;
type FunctionIndex = number;
type InstructionIndex = number;

interface SourcePosition {
  source: FilePath;
  line: Line;
}
interface CodePosition {
  funcIndex: FunctionIndex;
  instrIndex: InstructionIndex;
}

export class SourceMapAnalysis {
  rawBuffer: Promise<Buffer>;
  ast: Promise<WasmAst>;
  binaryToSourceMapping: Promise<Map<BinaryOffset, SourcePosition> | null>;
  instrToBinaryMapping: Promise<FunctionInstr[]>;
  sourceToInstrMapping: Promise<Map<FilePath, Map<Line, CodePosition>> | null>;

  constructor(wasmFilePath: string, workSpacePath: string) {
    this.rawBuffer = readFile(wasmFilePath);
    this.ast = this.rawBuffer.then((buf) => {
      return wasmParser(buf);
    });
    this.binaryToSourceMapping = this.ast.then(async (ast) => {
      if (ast.sourceMapUrl == null) {
        return null;
      }
      const sourceMapUrl = join(dirname(wasmFilePath), ast.sourceMapUrl);
      const sourceMap = JSON.parse(await readFile(sourceMapUrl, { encoding: "utf8" })) as RawSourceMap;
      return SourceMapConsumer.with(sourceMap, null, (consumer) => {
        const binaryToSourceMapping = new Map();
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
    this.sourceToInstrMapping = Promise.all([this.binaryToSourceMapping, this.instrToBinaryMapping]).then(
      ([binaryToSourceMapping, instrToBinaryMapping]) => {
        if (binaryToSourceMapping == null) {
          return null;
        }
        const binaryToInstrMapping = new Map<BinaryOffset, CodePosition>();
        instrToBinaryMapping.forEach((functionInstr, funcIndex) => {
          functionInstr.forEach((binaryOffset, instrIndex) => {
            binaryToInstrMapping.set(binaryOffset, { funcIndex, instrIndex });
          });
        });
        const result = new Map<FilePath, Map<Line, CodePosition>>();
        binaryToSourceMapping.forEach((sourcePosition, binaryOffset) => {
          const codePosition = binaryToInstrMapping.get(binaryOffset);
          assert(codePosition);
          let lineMap = result.get(sourcePosition.source);
          if (lineMap == undefined) {
            lineMap = new Map<Line, CodePosition>();
            result.set(sourcePosition.source, lineMap);
          }
          lineMap.set(sourcePosition.line, codePosition);
        });
        return result;
      }
    );
  }
}

export function instr2source(
  codePosition: CodePosition,
  instrTobinaryMapping: FunctionInstr[],
  binaryToSourceMapping: Map<number, SourcePosition>,
  onDelta: (delta: number) => void = () => {}
): SourcePosition | null {
  let { funcIndex, instrIndex } = codePosition;
  let sourcePosition: SourcePosition | null = null;
  const orginInstrIndex = instrIndex;
  for (; instrIndex >= 0; instrIndex--) {
    if (funcIndex >= instrTobinaryMapping.length) {
      break;
    }
    const functionInstr = instrTobinaryMapping[funcIndex];
    if (instrIndex >= functionInstr.length) {
      instrIndex = functionInstr.length;
      continue;
    }
    const binaryOffset = functionInstr[instrIndex];
    if (binaryOffset) {
      sourcePosition = binaryToSourceMapping.get(binaryOffset) ?? null;
      if (sourcePosition) {
        break;
      }
    }
  }
  if (sourcePosition) {
    if (instrIndex != orginInstrIndex) {
      onDelta(orginInstrIndex - instrIndex);
    }
  }
  return sourcePosition;
}

export function source2instr(
  sourcePosition: SourcePosition,
  sourceToInstrMapping: Map<FilePath, Map<Line, CodePosition>>
): CodePosition | null {
  const lineMap = sourceToInstrMapping.get(sourcePosition.source);
  if (lineMap == undefined) {
    return null;
  }
  const codePosition = lineMap.get(sourcePosition.line);
  if (codePosition == undefined) {
    return null;
  }
  return codePosition;
}
