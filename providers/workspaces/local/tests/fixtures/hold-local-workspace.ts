import { localWorkspace } from "../../src/index.js"

const directory = process.argv[2]

if (directory === undefined) {
  throw new Error("Local Workspace child requires a directory")
}

const provider = localWorkspace({ directory })
const lease = await provider.acquire({
  evaluationId: "local-workspace-child",
  id: "child-owner",
  signal: new AbortController().signal,
})

process.stdout.write("locked\n")

for await (const chunk of process.stdin) {
  if (chunk.toString().includes("release")) {
    break
  }
}

await lease.release()
process.stdout.write("released\n")
