/**
 * Safe, dependency-free mathematical expression parsing and evaluation for
 * browsers and Node.js. Only the explicit grammar in this module is accepted;
 * source text is never executed.
 * @module @agentrans/artifact/scene-expression
 */

const MAX_NODE_COUNT = 256
const MAX_DEPTH = 32

function at<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing value at index ${index}`)
  return value
}

function charAt(source: string, index: number): string {
  return source[index] ?? ''
}

function operatorValue(token: Token): BinaryOperator | undefined {
  return token.type === 'operator' ? token.value : undefined
}

function variableValue(variables: ExpressionVariables, name: string): number {
  const value = variables[name]
  if (value === undefined) throw new Error(`Variable "${name}" is missing`)
  return value
}

const DEFAULT_VARIABLES = ['x', 't', 'pi', 'e'] as const

type BinaryOperator = '+' | '-' | '*' | '/' | '^'
type FunctionName = 'sin' | 'cos' | 'tan' | 'exp' | 'log' | 'sqrt' | 'abs' | 'pow' | 'min' | 'max'

/** A validated mathematical expression tree. */
export type ExpressionNode =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'variable'; readonly name: string }
  | { readonly type: 'unary'; readonly operator: '-'; readonly operand: ExpressionNode }
  | {
    readonly type: 'binary'
    readonly operator: BinaryOperator
    readonly left: ExpressionNode
    readonly right: ExpressionNode
  }
  | { readonly type: 'call'; readonly name: FunctionName; readonly args: readonly ExpressionNode[] }

/** Finite numeric values indexed by variable name. */
export type ExpressionVariables = Readonly<Record<string, number>>

/** A mathematical operation has no finite real result for the supplied values. */
export class ExpressionDomainError extends Error {
  /** @param operation - Mathematical operation whose result is non-finite. */
  constructor(readonly operation: string) {
    super(`${operation} must be a finite number`)
    this.name = 'ExpressionDomainError'
  }
}

type Token =
  | { readonly type: 'number'; readonly value: number; readonly position: number }
  | { readonly type: 'identifier'; readonly value: string; readonly position: number }
  | { readonly type: 'operator'; readonly value: BinaryOperator; readonly position: number }
  | { readonly type: 'leftParen' | 'rightParen' | 'comma' | 'end'; readonly position: number }

function assertNever(value: never): never {
  throw new Error(`Unsupported expression node: ${String(value)}`)
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

function isIdentifierStart(character: string): boolean {
  return character >= 'a' && character <= 'z'
    || character >= 'A' && character <= 'Z'
    || character === '_'
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character)
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < expression.length) {
    const character = charAt(expression, index)
    if (/\s/.test(character)) {
      index += 1
      continue
    }

    const position = index + 1
    if (isDigit(character) || character === '.') {
      const start = index
      if (character === '.') {
        index += 1
        if (index >= expression.length || !isDigit(charAt(expression, index))) {
          throw new Error(`Invalid number at position ${position}: expected a digit after "."`)
        }
      }
      while (index < expression.length && isDigit(charAt(expression, index))) index += 1
      if (charAt(expression, index) === '.') {
        index += 1
        while (index < expression.length && isDigit(charAt(expression, index))) index += 1
      }
      if (charAt(expression, index) === 'e' || charAt(expression, index) === 'E') {
        index += 1
        if (charAt(expression, index) === '+' || charAt(expression, index) === '-') index += 1
        if (index >= expression.length || !isDigit(charAt(expression, index))) {
          throw new Error(`Invalid number at position ${start + 1}: expected exponent digits`)
        }
        while (index < expression.length && isDigit(charAt(expression, index))) index += 1
      }
      const source = expression.slice(start, index)
      const value = Number(source)
      if (!Number.isFinite(value)) {
        throw new Error(`Number "${source}" at position ${start + 1} must be finite`)
      }
      tokens.push({ type: 'number', value, position: start + 1 })
      continue
    }

    if (isIdentifierStart(character)) {
      const start = index
      index += 1
      while (index < expression.length && isIdentifierPart(charAt(expression, index))) index += 1
      tokens.push({ type: 'identifier', value: expression.slice(start, index), position })
      continue
    }

    if (character === '+' || character === '-' || character === '*'
      || character === '/' || character === '^') {
      tokens.push({ type: 'operator', value: character, position })
      index += 1
      continue
    }
    if (character === '(' || character === ')' || character === ',') {
      const type = character === '(' ? 'leftParen' : character === ')' ? 'rightParen' : 'comma'
      tokens.push({ type, position })
      index += 1
      continue
    }
    throw new Error(`Invalid character "${character}" at position ${position}`)
  }

  tokens.push({ type: 'end', position: expression.length + 1 })
  return tokens
}

class Parser {
  private index = 0
  private nodeCount = 0
  private nesting = 0

  constructor(
    private readonly tokens: readonly Token[],
    private readonly allowedVariables: ReadonlySet<string>,
  ) {}

  parse(): ExpressionNode {
    if (this.peek().type === 'end') throw new Error('Expression must not be empty')
    const node = this.parseAdditive()
    const token = this.peek()
    if (token.type !== 'end') {
      throw new Error(`Unexpected token at position ${token.position}`)
    }
    this.validateDepth(node)
    return node
  }

  private peek(): Token {
    return at(this.tokens, this.index)
  }

  private consume(): Token {
    const token = this.peek()
    this.index += 1
    return token
  }

  private create(node: ExpressionNode): ExpressionNode {
    this.nodeCount += 1
    if (this.nodeCount > MAX_NODE_COUNT) {
      throw new Error(`Expression exceeds the ${MAX_NODE_COUNT}-node limit`)
    }
    return node
  }

  private nested(parse: () => ExpressionNode): ExpressionNode {
    if (this.nesting >= MAX_DEPTH) throw new Error(`Expression depth exceeds ${MAX_DEPTH}`)
    this.nesting += 1
    try {
      return parse()
    } finally {
      this.nesting -= 1
    }
  }

  private parseAdditive(): ExpressionNode {
    let left = this.parseMultiplicative()
    while (this.peek().type === 'operator' && (operatorValue(this.peek()) === '+' || operatorValue(this.peek()) === '-')) {
      const operator = this.consume()
      if (operator.type !== 'operator') throw new Error('Internal parser error')
      const right = this.parseMultiplicative()
      left = this.create({ type: 'binary', operator: operator.value, left, right })
    }
    return left
  }

  private parseMultiplicative(): ExpressionNode {
    let left = this.parseUnary()
    while (this.peek().type === 'operator' && (operatorValue(this.peek()) === '*' || operatorValue(this.peek()) === '/')) {
      const operator = this.consume()
      if (operator.type !== 'operator') throw new Error('Internal parser error')
      const right = this.parseUnary()
      left = this.create({ type: 'binary', operator: operator.value, left, right })
    }
    return left
  }

  private parseUnary(): ExpressionNode {
    const token = this.peek()
    if (token.type === 'operator' && token.value === '-') {
      this.consume()
      const operand = this.nested(() => this.parseUnary())
      return this.create({ type: 'unary', operator: '-', operand })
    }
    return this.parsePower()
  }

  private parsePower(): ExpressionNode {
    const left = this.parsePrimary()
    const token = this.peek()
    if (token.type !== 'operator' || token.value !== '^') return left
    this.consume()
    const right = this.nested(() => this.parseUnary())
    return this.create({ type: 'binary', operator: '^', left, right })
  }

  private parsePrimary(): ExpressionNode {
    const token = this.consume()
    if (token.type === 'number') return this.create({ type: 'number', value: token.value })
    if (token.type === 'identifier') return this.parseIdentifier(token.value, token.position)
    if (token.type === 'leftParen') {
      const node = this.nested(() => this.parseAdditive())
      if (this.peek().type !== 'rightParen') {
        throw new Error(`Expected ")" at position ${this.peek().position} to close "(" at position ${token.position}`)
      }
      this.consume()
      return node
    }
    if (token.type === 'end') {
      throw new Error(`Expected an expression at position ${token.position}`)
    }
    throw new Error(`Expected a number, variable, function, or "(" at position ${token.position}`)
  }

  private parseIdentifier(name: string, position: number): ExpressionNode {
    if (this.peek().type !== 'leftParen') {
      if (!this.allowedVariables.has(name)) {
        throw new Error(`Unknown variable "${name}" at position ${position}`)
      }
      return this.create({ type: 'variable', name })
    }

    if (!isFunctionName(name)) throw new Error(`Unknown function "${name}" at position ${position}`)
    this.consume()
    const args: ExpressionNode[] = []
    if (this.peek().type !== 'rightParen') {
      while (true) {
        if (this.peek().type === 'comma') {
          throw new Error(`Expected an expression before "," at position ${this.peek().position}`)
        }
        args.push(this.nested(() => this.parseAdditive()))
        if (this.peek().type !== 'comma') break
        this.consume()
        if (this.peek().type === 'rightParen') {
          throw new Error(`Expected an expression after "," at position ${this.peek().position}`)
        }
      }
    }
    if (this.peek().type !== 'rightParen') {
      throw new Error(`Expected ")" at position ${this.peek().position} to close function "${name}"`)
    }
    this.consume()
    validateArity(name, args.length, position)
    return this.create({ type: 'call', name, args })
  }

  private validateDepth(root: ExpressionNode): void {
    const pending: { node: ExpressionNode; depth: number }[] = [{ node: root, depth: 1 }]
    while (pending.length > 0) {
      const entry = pending.pop()
      if (entry === undefined) continue
      if (entry.depth > MAX_DEPTH) throw new Error(`Expression depth exceeds ${MAX_DEPTH}`)
      switch (entry.node.type) {
        case 'number':
        case 'variable':
          break
        case 'unary':
          pending.push({ node: entry.node.operand, depth: entry.depth + 1 })
          break
        case 'binary':
          pending.push(
            { node: entry.node.left, depth: entry.depth + 1 },
            { node: entry.node.right, depth: entry.depth + 1 },
          )
          break
        case 'call':
          for (const argument of entry.node.args) {
            pending.push({ node: argument, depth: entry.depth + 1 })
          }
          break
        default:
          assertNever(entry.node)
      }
    }
  }
}

function isFunctionName(name: string): name is FunctionName {
  return name === 'sin' || name === 'cos' || name === 'tan' || name === 'exp'
    || name === 'log' || name === 'sqrt' || name === 'abs' || name === 'pow'
    || name === 'min' || name === 'max'
}

function validateArity(name: FunctionName, count: number, position: number): void {
  if (name === 'min' || name === 'max') {
    if (count < 1) throw new Error(`Function "${name}" at position ${position} requires at least 1 argument`)
    return
  }
  const expected = name === 'pow' ? 2 : 1
  if (count !== expected) {
    throw new Error(`Function "${name}" at position ${position} requires exactly ${expected} argument${expected === 1 ? '' : 's'}, received ${count}`)
  }
}

/**
 * Parse mathematical source into a bounded expression tree without executing it.
 * @param expression - Source containing numbers, variables, supported operators, and function calls.
 * @param allowedVariables - Additional variable names beyond the built-in `x`, `t`, `pi`, and `e`.
 * @returns The validated expression tree, containing at most 256 nodes and 32 levels.
 * @throws {Error} For empty or malformed source, unsupported names, invalid arity, or exceeded limits.
 */
export function parseExpression(expression: string, allowedVariables: readonly string[]): ExpressionNode {
  const variables = new Set<string>([...DEFAULT_VARIABLES, ...allowedVariables])
  return new Parser(tokenize(expression), variables).parse()
}

function finite(value: number, description: string): number {
  if (!Number.isFinite(value)) throw new Error(`${description} must be a finite number`)
  return value
}

function finiteResult(value: number, operation: string): number {
  if (!Number.isFinite(value)) throw new ExpressionDomainError(operation)
  return value
}

function evaluateCall(name: FunctionName, args: readonly number[]): number {
  switch (name) {
    case 'sin': return Math.sin(at(args, 0))
    case 'cos': return Math.cos(at(args, 0))
    case 'tan': return Math.tan(at(args, 0))
    case 'exp': return Math.exp(at(args, 0))
    case 'log': return Math.log(at(args, 0))
    case 'sqrt': return Math.sqrt(at(args, 0))
    case 'abs': return Math.abs(at(args, 0))
    case 'pow': return Math.pow(at(args, 0), at(args, 1))
    case 'min': return Math.min(...args)
    case 'max': return Math.max(...args)
    default: return assertNever(name)
  }
}

/**
 * Evaluate a parsed expression using only the supplied variable values.
 * @param node - Expression tree produced by {@link parseExpression}.
 * @param variables - Numeric values for every variable referenced by the tree.
 * @returns The finite numeric result.
 * @throws {ExpressionDomainError} When a mathematical operation produces a non-finite intermediate or final result.
 * @throws {Error} When a variable or literal is missing or non-finite, or the tree contains an unsupported node.
 */
export function evaluateExpression(node: ExpressionNode, variables: ExpressionVariables): number {
  switch (node.type) {
    case 'number':
      return finite(node.value, 'Number literal')
    case 'variable':
      return finite(variableValue(variables, node.name), `Variable "${node.name}"`)
    case 'unary':
      return finiteResult(-evaluateExpression(node.operand, variables), 'Unary operation result')
    case 'binary': {
      const left = evaluateExpression(node.left, variables)
      const right = evaluateExpression(node.right, variables)
      switch (node.operator) {
        case '+': return finiteResult(left + right, 'Addition result')
        case '-': return finiteResult(left - right, 'Subtraction result')
        case '*': return finiteResult(left * right, 'Multiplication result')
        case '/': return finiteResult(left / right, 'Division result')
        case '^': return finiteResult(Math.pow(left, right), 'Exponentiation result')
        default: throw new Error('Unsupported binary operator')
      }
    }
    case 'call': {
      const args = node.args.map(argument => evaluateExpression(argument, variables))
      return finiteResult(evaluateCall(node.name, args), `Function "${node.name}" result`)
    }
    default:
      return assertNever(node)
  }
}
