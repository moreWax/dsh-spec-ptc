/**
 * run_code tool-call stream → ```repl feed adapter.
 *
 * The upstream daemon's shadow REPL only opens on ```repl fences containing
 * PYTHON statements calling registered tools by bare name. dsh Code Mode
 * instead streams code as the JSON string value of the run_code tool-call's
 * `code` argument, in Python flavor shaped as `await tools.name(args)`.
 *
 * This adapter translates the stream in flight:
 *   tool-call-delta(run_code, argumentsDelta)  ──▶  "```repl\n" + code + "\n```"
 * with a streaming JSON-string parser (chunk boundaries can fall anywhere,
 * including mid-escape) and a line-buffered rewrite of the dsh call
 * convention to bare-name calls the shadow can hook.
 *
 * TypeScript-flavor code passes through verbatim inside the fence; the
 * daemon's ast.parse aborts it, evicting that block's speculation — fail-open
 * by construction. Speculation is advisory: the real execution path is
 * always authoritative.
 *
 * @module
 */

/** The chunk shapes this adapter consumes (structural subset of dsh-llm stream chunks). */
export interface ToolCallDeltaChunk {
  type: 'tool-call-delta'
  index: number
  name?: string
  argumentsDelta: string
}

const RUN_CODE = 'run_code'
const FENCE_OPEN = '```repl\n'
const FENCE_CLOSE = '\n```\n'

/** Parser states for the streaming JSON string-field extractor. */
const SEEK_KEY = 0       // between tokens, hunting the next "key"
const IN_KEY = 1         // inside a "key" string
const SEEK_COLON = 2     // after a key, hunting ':'
const SEEK_VALUE = 3     // after ':', hunting the value's opening quote
const IN_CODE = 4        // inside the "code" string value → emit chars
const IN_OTHER = 5       // inside some other string value → swallow chars
const SKIP_VALUE = 6     // inside a non-string value (number/bool/null/obj) → swallow until ',' or '}'
const DONE = 7           // closing '}' of the top-level object seen

export class ReplFeedAdapter {
  private state: number = SEEK_KEY
  private keyBuf = ''
  private currentKey = ''
  private escaped = false
  private unicodeBuf: string | undefined
  private lineBuf = ''
  private activeIndex: number | undefined
  private open = false

  /**
   * Push one tool-call-delta chunk; returns the feed strings to send to the
   * daemon IN ORDER (possibly empty, possibly several).
   */
  push(chunk: ToolCallDeltaChunk): string[] {
    // A different call index closes any open fence first.
    if (this.open && this.activeIndex !== chunk.index) {
      const tail = this.closeFence()
      this.activeIndex = chunk.index
      if (chunk.name !== RUN_CODE) return tail
      return [...tail, ...this.openFence(), ...this.consume(chunk.argumentsDelta)]
    }
    if (!this.open) {
      if (chunk.name !== RUN_CODE) return []
      this.activeIndex = chunk.index
      return [...this.openFence(), ...this.consume(chunk.argumentsDelta)]
    }
    return this.consume(chunk.argumentsDelta)
  }

  /** The tool-call stream ended (index change handled by push; call this on turn/message end). */
  finish(): string[] {
    return this.open ? this.closeFence() : []
  }

  private openFence(): string[] {
    this.open = true
    this.state = SEEK_KEY
    this.keyBuf = ''
    this.currentKey = ''
    this.escaped = false
    this.unicodeBuf = undefined
    this.lineBuf = ''
    return [FENCE_OPEN]
  }

  private closeFence(): string[] {
    const out: string[] = []
    const rest = rewriteLine(this.lineBuf)
    if (rest !== '') out.push(rest)
    out.push(FENCE_CLOSE)
    this.open = false
    this.lineBuf = ''
    return out
  }

  /** Streaming JSON scan: emit unescaped chars of the "code" string value only. */
  private consume(delta: string): string[] {
    const emitted: string[] = []
    for (const ch of delta) {
      switch (this.state) {
        case SEEK_KEY:
          if (ch === '"') { this.state = IN_KEY; this.keyBuf = '' }
          else if (ch === '}') this.state = DONE
          break
        case IN_KEY:
          if (ch === '\\') { this.escaped = true; break }
          if (ch === '"' && !this.escaped) {
            this.currentKey = this.keyBuf
            this.keyBuf = ''
            this.state = SEEK_COLON
            break
          }
          this.escaped = false
          this.keyBuf += ch
          break
        case SEEK_COLON:
          if (ch === ':') this.state = SEEK_VALUE
          break
        case SEEK_VALUE:
          if (ch === '"') {
            this.state = this.currentKey === 'code' ? IN_CODE : IN_OTHER
            this.escaped = false
            this.unicodeBuf = undefined
          } else if (ch === '{' || ch === '[') {
            // nested container value: not code; swallow to next key crudely
            this.state = SKIP_VALUE
          } else if (/[0-9tfn-]/.test(ch)) {
            this.state = SKIP_VALUE
          }
          break
        case IN_CODE: {
          const unescaped = this.unescapeChar(ch)
          if (unescaped !== undefined) emitted.push(unescaped)
          if (this.state === IN_CODE) break // still inside; unescapeChar manages state
          // state flipped by unescapeChar hitting the closing quote
          this.state = SEEK_KEY
          break
        }
        case IN_OTHER: {
          this.unescapeChar(ch)
          if ((this.state as number) !== IN_OTHER) this.state = SEEK_KEY
          break
        }
        case SKIP_VALUE:
          if (ch === ',') this.state = SEEK_KEY
          else if (ch === '}') this.state = DONE
          break
        default:
          break
      }
    }
    if (emitted.length === 0) return []
    return this.emitLines(emitted.join(''))
  }

  /**
   * Unescape one raw JSON-string char. Returns the decoded char to emit, or
   * undefined when the char was structural (escape lead-in, closing quote —
   * which flips this.state to DONE as a signal) or an incomplete sequence.
   */
  private unescapeChar(ch: string): string | undefined {
    if (this.unicodeBuf !== undefined) {
      this.unicodeBuf += ch
      if (this.unicodeBuf.length < 4) return undefined
      const decoded = String.fromCharCode(parseInt(this.unicodeBuf, 16))
      this.unicodeBuf = undefined
      return decoded
    }
    if (this.escaped) {
      this.escaped = false
      switch (ch) {
        case 'n': return '\n'
        case 't': return '\t'
        case 'r': return '\r'
        case 'b': return '\b'
        case 'f': return '\f'
        case 'u': this.unicodeBuf = ''; return undefined
        default: return ch // covers JSON quote, backslash, slash, and unknown escapes
      }
    }
    if (ch === '\\') { this.escaped = true; return undefined }
    if (ch === '"') { this.state = DONE; return undefined } // closing quote
    return ch
  }

  /** Line-buffered rewrite: only complete lines leave, so regexes never see torn statements. */
  private emitLines(text: string): string[] {
    this.lineBuf += text
    const out: string[] = []
    let nl = this.lineBuf.indexOf('\n')
    while (nl !== -1) {
      const line = this.lineBuf.slice(0, nl)
      out.push(rewriteLine(line) + '\n')
      this.lineBuf = this.lineBuf.slice(nl + 1)
      nl = this.lineBuf.indexOf('\n')
    }
    return out
  }
}

/** dsh Python Code Mode call convention → shadow-hookable bare-name calls. */
export function rewriteLine(line: string): string {
  return line
    .replace(/await\s+tools\.([A-Za-z_]\w*)\s*\(/g, '$1(')
    .replace(/(?<![\w.])tools\.([A-Za-z_]\w*)\s*\(/g, '$1(')
}
