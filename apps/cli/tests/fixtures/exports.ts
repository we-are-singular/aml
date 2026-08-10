export default "default result"

export async function alternate() {
  await Promise.resolve()
  return ["named", " result"]
}
