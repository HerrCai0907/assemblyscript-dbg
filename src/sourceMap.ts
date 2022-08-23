import { promises } from "fs";
import { decode as parser } from "@webassemblyjs/wasm-parser";
import { RawSourceMap, SourceMapConsumer } from "source-map";
import { WasmAst } from "./wasmAstType";
import { dirname, join, relative } from "path";
const readFile = promises.readFile;

function readLEBU32(buffer: Buffer, offset: number) {
  let u32 = 0;
  let shift = 0;
  while (true) {
    let byte = buffer.readUInt8(offset + shift);
    byte = byte < 0 ? 256 + byte : byte;
    u32 |= (byte & 0x7f) << (shift * 7);
    shift += 1;
    if (byte < 128) {
      break;
    }
  }
  return { u32, shift };
}

export interface SourcePosition {
  source: string;
  line: number;
}
type FuncIndex = number;
type InstruIndex = number;
type CodeOffset = number;

export class SourceMapAnalysis {
  rawBuffer: Promise<Buffer>;
  ast: Promise<WasmAst>;
  binayToSourceMapping: Promise<Map<CodeOffset, SourcePosition> | null>;
  instrToBinayMapping: Promise<Map<FuncIndex, Map<InstruIndex, CodeOffset>>>;

  constructor(wasmFilePath: string, workSpacePath: string) {
    this.rawBuffer = readFile(wasmFilePath);
    this.ast = this.rawBuffer.then((buf) => {
      return parser(buf, { ignoreDataSection: true }) as WasmAst;
    });
    this.binayToSourceMapping = Promise.all([this.rawBuffer, this.ast]).then(async ([buf, ast]) => {
      let sourceMapUrl: string | null = null;
      const sections = ast.body[0].metadata.sections;
      for (let i = 0, k = sections.length; i < k; i++) {
        const section = sections[i];
        if (section.section !== "custom") {
          continue;
        }
        const strBegin = section.size.loc.end.column;
        if (buf.readInt8(strBegin) !== 16 || buf.slice(strBegin + 1, strBegin + 17).toString("utf8") !== "sourceMappingURL") {
          continue;
        }
        const { u32, shift } = readLEBU32(buf, strBegin + 17);
        const urlBegin = strBegin + 17 + shift;
        const urlLength = u32;
        sourceMapUrl = buf.slice(urlBegin, urlBegin + urlLength).toString("utf8");
        break;
      }
      if (sourceMapUrl == null) {
        return null;
      }
      sourceMapUrl = join(dirname(wasmFilePath), sourceMapUrl);
      const sourceMap: RawSourceMap = JSON.parse(await readFile(sourceMapUrl, { encoding: "utf8" }));
      return SourceMapConsumer.with(sourceMap, null, (consumer) => {
        let binaryToSourceMapping = new Map();
        consumer.eachMapping((m) => {
          let source = sourceMap.sourceRoot ? relative(sourceMap.sourceRoot, m.source) : m.source;
          source = join(workSpacePath, source);
          binaryToSourceMapping.set(m.generatedColumn, { source, line: m.originalLine });
        });
        return binaryToSourceMapping;
      });
    });
    this.instrToBinayMapping = this.ast.then((ast) => {
      const instrToBinayMapping = new Map<FuncIndex, Map<InstruIndex, CodeOffset>>();
      ast.body[0].fields
        .filter((field) => field.type === "Func")
        .forEach((func, funcIndex) => {
          func.body?.forEach((instr, instruIndex) => {
            let instrMapping = instrToBinayMapping.get(funcIndex);
            if (instrMapping == undefined) {
              instrMapping = new Map();
              instrToBinayMapping.set(funcIndex, instrMapping);
            }
            instrMapping.set(instruIndex, instr.loc.start.column);
          });
        });
      return instrToBinayMapping;
    });
  }
}
