export interface CalculatorResult {
  expression: string;
  value: number | null;
  error: string | null;
}

type TokenType =
  | "NUMBER"
  | "IDENT"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "CARET"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "EOF";

interface Token {
  type: TokenType;
  value?: string | number;
}

const TOKEN_RE =
  /^\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\+)|(-)|(\*)|(\/)|(%)|(\^)|(\()|(\))|(,))/;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: (x) => Math.sqrt(x),
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  log: (x) => Math.log10(x),
  ln: (x) => Math.log(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
};

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): number {
    const value = this.expr();
    if (this.peek().type !== "EOF") {
      throw new Error("expressão inválida");
    }
    return value;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const token = this.next();
    if (token.type !== type) {
      throw new Error(`esperado ${type}, encontrado ${token.type}`);
    }
    return token;
  }

  private expr(): number {
    let left = this.term();
    while (this.peek().type === "PLUS" || this.peek().type === "MINUS") {
      const op = this.next().type;
      const right = this.term();
      left = op === "PLUS" ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.power();
    while (
      this.peek().type === "STAR" ||
      this.peek().type === "SLASH" ||
      this.peek().type === "PERCENT"
    ) {
      const op = this.next().type;
      const right = this.power();
      if (op === "STAR") {
        left = left * right;
      } else if (op === "SLASH") {
        if (right === 0) throw new Error("divisão por zero");
        left = left / right;
      } else {
        if (right === 0) throw new Error("módulo por zero");
        left = left % right;
      }
    }
    return left;
  }

  private power(): number {
    const base = this.unary();
    if (this.peek().type === "CARET") {
      this.next();
      return Math.pow(base, this.power());
    }
    return base;
  }

  private unary(): number {
    if (this.peek().type === "MINUS") {
      this.next();
      return -this.unary();
    }
    if (this.peek().type === "PLUS") {
      this.next();
      return this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.peek();
    if (token.type === "NUMBER") {
      this.next();
      return token.value as number;
    }
    if (token.type === "LPAREN") {
      this.next();
      const value = this.expr();
      this.expect("RPAREN");
      return value;
    }
    if (token.type === "IDENT") {
      this.next();
      const name = token.value as string;
      if (this.peek().type === "LPAREN") {
        this.next();
        const args: number[] = [];
        if (this.peek().type !== "RPAREN") {
          args.push(this.expr());
          while (this.peek().type === "COMMA") {
            this.next();
            args.push(this.expr());
          }
        }
        this.expect("RPAREN");
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`função desconhecida: ${name}`);
        return fn(...args);
      }
      const constant = CONSTANTS[name];
      if (constant === undefined) {
        throw new Error(`constante desconhecida: ${name}`);
      }
      return constant;
    }
    throw new Error(`expressão inesperada`);
  }
}

const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let rest = input;
  while (rest.length) {
    const match = TOKEN_RE.exec(rest);
    if (!match) {
      throw new Error(`caractere inesperado: "${rest[0]}"`);
    }
    if (match[1]) tokens.push({ type: "NUMBER", value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: "IDENT", value: match[2] });
    else if (match[3]) tokens.push({ type: "PLUS" });
    else if (match[4]) tokens.push({ type: "MINUS" });
    else if (match[5]) tokens.push({ type: "STAR" });
    else if (match[6]) tokens.push({ type: "SLASH" });
    else if (match[7]) tokens.push({ type: "PERCENT" });
    else if (match[8]) tokens.push({ type: "CARET" });
    else if (match[9]) tokens.push({ type: "LPAREN" });
    else if (match[10]) tokens.push({ type: "RPAREN" });
    else if (match[11]) tokens.push({ type: "COMMA" });
    rest = rest.slice(match[0].length);
  }
  tokens.push({ type: "EOF" });
  return tokens;
};

const SAFE_CHARS = /^[0-9+\-*/%^().,\sA-Za-z_]+$/;

/**
 * Avalia `expression` (aritmética) de forma confiável — o modelo nunca
 * "calcula": um parser próprio avalia + - * / % ^, parênteses, constantes
 * (pi, e, tau) e funções (sqrt, sin, cos, tan, abs, round, floor, ceil,
 * log, ln, min, max). Zero dependências, sem eval.
 */
export const Calculator = (expression: string): CalculatorResult => {
  const trimmed = expression.trim();
  if (!trimmed) return { expression, value: null, error: "expressão vazia" };
  if (!SAFE_CHARS.test(trimmed)) {
    return {
      expression,
      value: null,
      error: "expressão contém caracteres não permitidos",
    };
  }

  try {
    const value = new Parser(tokenize(trimmed)).parse();
    if (!Number.isFinite(value)) {
      return {
        expression,
        value: null,
        error: "resultado não é um número finito",
      };
    }
    return { expression, value, error: null };
  } catch (error) {
    return {
      expression,
      value: null,
      error: error instanceof Error ? error.message : "erro de avaliação",
    };
  }
};
