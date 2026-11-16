/**
 * A small GraphQL implementation for the forge: lexer, parser (operations,
 * fragments, variables, input objects, enums, aliases) and an executor over
 * a hand-rolled schema whose objects are the same records REST and MCP use.
 * Unknown fields produce field errors naming the field, as GitHub does.
 */

// --------------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'ellipsis' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

export interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`GraphQL parse: expected ${value}, got ${token.value}`);
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArgs();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('GraphQL parse: fragment without type condition');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`GraphQL parse: unexpected token ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
    }
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.peek().value === '(' ? this.parseArgs() : new Map<string, ValueNode>();
    this.skipDirectives();
    const selectionSet = this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArgs(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL parse: unexpected value token ${token.value}`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

export function valueFromNode(node: ValueNode | undefined, variables: Record<string, unknown>): unknown {
  if (!node) return undefined;
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((value) => valueFromNode(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}
