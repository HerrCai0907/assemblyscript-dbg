let globalI32 = 100;

export function fibonacci(n: i32): i32 {
  if (n == 0) {
    return 0;
  } else if (n == 1) {
    return 1;
  } else {
    return fibonacci(n - 1) + fibonacci(n - 2);
  }
}

export function arrayOperator(): void {
  let a = new Array<i32>();
  a.push(globalI32);
}
