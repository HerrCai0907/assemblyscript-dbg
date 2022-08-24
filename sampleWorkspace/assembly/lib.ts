export function fibonacci(n: i32): i32 {
  if (n == 0) {
    return 0;
  } else if (n == 1) {
    return 1;
  } else {
    return fibonacci(n - 1) + fibonacci(n + 1);
  }
}

export function arrayOperator(): void {
  let a = new Array<i32>();
  a.push(100);
}
