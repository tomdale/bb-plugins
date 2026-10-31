import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { codeHostContract } from "./src/code-contract.ts";
import { changedFiles, readCode } from "./src/host-code.ts";

export default experimental_defineHostEntry({
  contract: codeHostContract,
  handlers: {
    readCode: (input, context) => readCode(input, context.signal),
    changedFiles: (input, context) => changedFiles(input, context.signal),
  },
});
