export async function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []

    const timer = setTimeout(() => {
      process.stdin.removeAllListeners()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }, timeoutMs)

    if (process.stdin.isTTY) {
      clearTimeout(timer)
      resolve('')
      return
    }

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })

    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}
