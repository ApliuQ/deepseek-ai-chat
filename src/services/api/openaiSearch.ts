/** 跨分片剥除伪工具标记；工具只能由模型服务端执行。 */
export const createLiteralToolFilter = () => {
  const opening = '<tool_call>'
  const closing = '</tool_call>'
  let pending = ''
  let inside = false
  return (fragment: string, final = false): string => {
    pending += fragment
    let text = ''
    while (pending) {
      if (inside) {
        const end = pending.indexOf(closing)
        if (end < 0) {
          pending = final ? '' : pending.slice(-(closing.length - 1))
          return text
        }
        pending = pending.slice(end + closing.length)
        inside = false
      } else {
        const start = pending.indexOf(opening)
        if (start >= 0) {
          text += pending.slice(0, start)
          pending = pending.slice(start + opening.length)
          inside = true
        } else {
          let keep = 0
          for (let length = 1; length < opening.length; length++) {
            if (pending.endsWith(opening.slice(0, length))) {
              keep = length
            }
          }
          text += pending.slice(0, pending.length - keep)
          pending = final ? '' : pending.slice(pending.length - keep)
          break
        }
      }
    }
    return text
  }
}
