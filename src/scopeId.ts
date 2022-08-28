export enum FixedScopeId {
  ValueStack = 1,
  Global = 2,
  StackLocalBase = 10,
}

export class ScopeId {
  static getStackId(stack: number) {
    return FixedScopeId.StackLocalBase + stack;
  }
  static getGlobalId() {
    return FixedScopeId.Global;
  }
  static getValueStackId() {
    return FixedScopeId.ValueStack;
  }

  static getStack(variablesReference: number) {
    return variablesReference - FixedScopeId.StackLocalBase;
  }
}
