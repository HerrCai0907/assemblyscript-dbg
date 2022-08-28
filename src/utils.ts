import assert = require("assert");
import * as proto from "./proto/interface_pb";

export function value2number(value: proto.Value): number {
  switch (value.getValueCase()) {
    case proto.Value.ValueCase.I32: {
      return value.getI32();
    }
    case proto.Value.ValueCase.I64: {
      return value.getI64();
    }
    case proto.Value.ValueCase.F32: {
      return value.getF32();
    }
    case proto.Value.ValueCase.F64: {
      return value.getF64();
    }
  }
  assert(false);
}
export function number2value(value: number, type: proto.Value.ValueCase): proto.Value {
  switch (type) {
    case proto.Value.ValueCase.I32: {
      return new proto.Value().setI32(value);
    }
    case proto.Value.ValueCase.I64: {
      return new proto.Value().setI64(value);
    }
    case proto.Value.ValueCase.F32: {
      return new proto.Value().setF32(value);
    }
    case proto.Value.ValueCase.F64: {
      return new proto.Value().setF64(value);
    }
  }
  assert(false);
}

export function value2str(value: proto.Value | undefined): string {
  if (value == undefined) {
    return "unknown";
  }
  return value2number(value).toString();
}

export function updateValue(value: proto.Value, updateValue: number) {
  switch (value.getValueCase()) {
    case proto.Value.ValueCase.I32:
      value.setI32(updateValue);
      break;
    case proto.Value.ValueCase.I64:
      value.setI64(updateValue);
      break;
    case proto.Value.ValueCase.F32:
      value.setF32(updateValue);
      break;
    case proto.Value.ValueCase.F64:
      value.setF64(updateValue);
      break;
  }
}

export async function sleep(timeMs: number) {
  return new Promise<void>((resolved) => {
    setTimeout(() => {
      resolved();
    }, timeMs);
  });
}
