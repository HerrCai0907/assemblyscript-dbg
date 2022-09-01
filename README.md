# assemblyscript-dbg

vscode extension for assemblyscript debugger

## How to use

### environment

- rustc >= 1.63
- protobuf >= 3.15

Before using, please install wasmdbg-grpc from github

```bash
cargo install wasmdbg-grpc --git https://github.com/HerrCai0907/wasmdbg.git
```

### recommand compile flag

```json
"options": {
  "disable": ["sign-extension", "nontrapping-f2i", "bulk-memory"],
  "runtime": "stub"
}
```

Due to some compiler bug, in increment runtime souce-map miss lots of information, so use stub runtime is easy to debug.

Now interpreter does not support some instruction, so disable some ASC feature is also needed.

### import function

in `launch.json`, you can define a list of files to provide import function

```json
"configurations": [
  {
    "type": "assemblyscript-debug",
    "request": "launch",
    "name": "Ask for file name",
    "program": "${workspaceFolder}/build/debug.wasm",
    "cwd": "${workspaceFolder}",
    "apiFiles": ["${workspaceFolder}/api.cjs"]
  }
]
```

```javascript
// api.cjs
module.exports = {
  env: {
    trace: (extension, args, memory, globals) => {
      // actually extension already provide it, but you can replace it by yourself
      const offset = args[0];
      const n = args[1];
      extension.logInfo(
        `trace: ${extension.helper.getString(offset, memory)}${n ? " " : ""}${args.slice(2, 2 + n).join(", ")}`
      );
      return null;
    },
  },
  index: {
    getI32: (extension, args, memory, globals) => {
      extension.logInfo(`call getI32, will return ${1024}`);
      return 1024;
    },
  },
};
```
