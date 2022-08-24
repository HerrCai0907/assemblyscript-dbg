import { readFileSync } from "fs";
import { wasmParser } from "../src/wasmParser";

let buf = readFileSync("sampleWorkspace/build/debug.wasm");
let ast = wasmParser(buf);
console.log(JSON.stringify(ast));
