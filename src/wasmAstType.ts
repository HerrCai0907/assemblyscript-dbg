export interface WasmAst {
  type: string;
  body: AstBody[];
}

export interface AstBody {
  type: string;
  id: null;
  fields: Field[];
  metadata: BodyMetadata;
}

export interface Field {
  type: string;
  functype?: Functype;
  loc?: LOC;
  elementType?: string;
  limits?: Limits;
  name?: NameClass | string;
  id?: IDElement;
  index?: IDElement;
  table?: IDElement;
  offset?: Offset[];
  funcs?: any[];
  signature?: Functype;
  body?: FieldBody[];
  metadata?: FieldMetadata;
  descr?: Descr;
}

export interface FieldBody {
  type: BodyType;
  id: string;
  args?: IDElement[];
  loc: LOC;
  object?: string;
  index?: Index;
  numeric?: IDElement;
}

export interface IDElement {
  type: IDType;
  name?: string;
  value?: number;
  raw?: string;
  loc?: LOC;
}

export interface LOC {
  start: End;
  end: End;
}

export interface End {
  line: number;
  column: number;
}

export enum IDType {
  NumberLiteral = "NumberLiteral",
  ValtypeLiteral = "ValtypeLiteral",
}

export interface Index {
  type: string;
  value: string;
}

export enum BodyType {
  CallInstruction = "CallInstruction",
  Instr = "Instr",
}

export interface Descr {
  type: string;
  exportType: string;
  id: DescrID;
}

export interface DescrID {
  type: string;
  value: number | string;
  raw?: string;
}

export interface Functype {
  type: string;
  params: any[];
  results: string[];
}

export interface Limits {
  type: string;
  min: number;
  max?: number;
}

export interface FieldMetadata {
  bodySize: number;
}

export interface NameClass {
  type: string;
  value: string;
  raw?: string;
  numeric?: string;
}

export interface Offset {
  type: BodyType;
  id: string;
  args: IDElement[];
  object?: string;
  loc: LOC;
}

export interface BodyMetadata {
  type: string;
  sections: Section[];
  functionNames: FunctionName[];
  localNames: LocalName[];
}

export interface FunctionName {
  type: string;
  value: string;
  index: number;
}

export interface LocalName {
  type: string;
  value: string;
  localIndex: number;
  functionIndex: number;
}

export interface Section {
  type: SectionType;
  section: string;
  startOffset: number;
  size: Size;
  vectorOfSize?: IDElement;
}

export interface Size {
  type: IDType;
  name: string;
  value: number;
  raw: string;
  loc: LOC;
}

export enum SectionType {
  SectionMetadata = "SectionMetadata",
}
