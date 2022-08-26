module.exports = {
  env: {
    trace: (extension, args, memory, globals) => {
      // actually extension already provide it, but you can replace it by yourself
      const offset = args[0];
      const n = args[1];
      extension.logInfo(
        `trace: ${extension.helper.getString(offset, memory)}${n ? " " : ""}${args.slice(2, 2 + n).join(", ")}\n`
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
