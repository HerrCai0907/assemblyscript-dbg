import { arrayOperator, fibonacci } from "./lib";

declare function getI32(): i32;

export function _start(): void {
  let v = getI32();
  trace("hhhh", 1, v);
  let a = 1;
  let b = 2.5;
  let c = fibonacci(4);
  arrayOperator();
}

_start();
