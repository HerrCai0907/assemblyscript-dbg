export enum FixedScopeId {
  Global = 0,
  ValueStack = 1,
  StackLocalBase = 2,
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
