import type { ArtifactDocument, ArtifactEdits, ArtifactSheet } from '@/shared/artifacts';

type FormulaEdits = Extract<ArtifactEdits, { kind: 'xlsx' }> | undefined;
const MAX_FORMULA_RANGE_CELLS = 50_000;
type Scalar = number | string | boolean;
type FormulaValue = Scalar | FormulaError | FormulaRange;
type FormulaRange = Readonly<{ kind: 'range'; values: readonly FormulaValue[]; rows: number; columns: number }>;
type Node =
  | Readonly<{ kind: 'literal'; value: Scalar }>
  | Readonly<{ kind: 'reference'; address: string }>
  | Readonly<{ kind: 'range'; start: string; end: string }>
  | Readonly<{ kind: 'unary'; operator: '+' | '-'; value: Node }>
  | Readonly<{ kind: 'binary'; operator: string; left: Node; right: Node }>
  | Readonly<{ kind: 'call'; name: string; arguments: readonly Node[] }>
  | Readonly<{ kind: 'percent'; value: Node }>;

class FormulaError {
  readonly code: string;
  constructor(code: string) { this.code = code; }
}

type Token = Readonly<{ type: 'number' | 'string' | 'identifier' | 'operator' | 'left' | 'right' | 'comma' | 'colon' | 'end'; value: string }>;

const tokenize = (source: string): readonly Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/u);
    if (whitespace) { index += whitespace[0].length; continue; }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/u);
    if (number) { tokens.push({ type: 'number', value: number[0] }); index += number[0].length; continue; }
    if (rest[0] === '"') {
      let value = '';
      index += 1;
      while (index < source.length) {
        if (source[index] !== '"') { value += source[index]; index += 1; continue; }
        if (source[index + 1] === '"') { value += '"'; index += 2; continue; }
        index += 1;
        break;
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    const identifier = rest.match(/^\$?[A-Za-z_][A-Za-z0-9_.]*\$?\d*|^(?:TRUE|FALSE)/iu);
    if (identifier) { tokens.push({ type: 'identifier', value: identifier[0].replaceAll('$', '').toUpperCase() }); index += identifier[0].length; continue; }
    const pair = rest.slice(0, 2);
    if (['<=', '>=', '<>'].includes(pair)) { tokens.push({ type: 'operator', value: pair }); index += 2; continue; }
    const single: Record<string, Token['type']> = { '(': 'left', ')': 'right', ',': 'comma', ';': 'comma', ':': 'colon' };
    if (single[rest[0] ?? '']) { tokens.push({ type: single[rest[0] ?? ''] as Token['type'], value: rest[0] ?? '' }); index += 1; continue; }
    if ('+-*/^&%=<>'.includes(rest[0] ?? '')) { tokens.push({ type: 'operator', value: rest[0] ?? '' }); index += 1; continue; }
    throw new FormulaError('#VALUE!');
  }
  return [...tokens, { type: 'end', value: '' }];
};

class Parser {
  private index = 0;
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) { this.tokens = tokens; }
  parse(): Node {
    const node = this.comparison();
    if (this.peek().type !== 'end') throw new FormulaError('#VALUE!');
    return node;
  }
  private peek(): Token { return this.tokens[this.index] ?? { type: 'end', value: '' }; }
  private take(): Token { const token = this.peek(); this.index += 1; return token; }
  private operator(value: string): boolean {
    if (this.peek().type !== 'operator' || this.peek().value !== value) return false;
    this.take(); return true;
  }
  private comparison(): Node {
    let node = this.concat();
    while (this.peek().type === 'operator' && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek().value)) {
      const operator = this.take().value;
      node = { kind: 'binary', operator, left: node, right: this.concat() };
    }
    return node;
  }
  private concat(): Node {
    let node = this.additive();
    while (this.operator('&')) node = { kind: 'binary', operator: '&', left: node, right: this.additive() };
    return node;
  }
  private additive(): Node {
    let node = this.multiplicative();
    while (this.peek().type === 'operator' && ['+', '-'].includes(this.peek().value)) {
      const operator = this.take().value;
      node = { kind: 'binary', operator, left: node, right: this.multiplicative() };
    }
    return node;
  }
  private multiplicative(): Node {
    let node = this.power();
    while (this.peek().type === 'operator' && ['*', '/'].includes(this.peek().value)) {
      const operator = this.take().value;
      node = { kind: 'binary', operator, left: node, right: this.power() };
    }
    return node;
  }
  private power(): Node {
    let node = this.unary();
    if (this.operator('^')) node = { kind: 'binary', operator: '^', left: node, right: this.power() };
    return node;
  }
  private unary(): Node {
    if (this.operator('+')) return { kind: 'unary', operator: '+', value: this.unary() };
    if (this.operator('-')) return { kind: 'unary', operator: '-', value: this.unary() };
    let node = this.primary();
    while (this.operator('%')) node = { kind: 'percent', value: node };
    return node;
  }
  private primary(): Node {
    const token = this.take();
    if (token.type === 'number') return { kind: 'literal', value: Number(token.value) };
    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'left') {
      const node = this.comparison();
      if (this.take().type !== 'right') throw new FormulaError('#VALUE!');
      return node;
    }
    if (token.type !== 'identifier') throw new FormulaError('#VALUE!');
    if (token.value === 'TRUE' || token.value === 'FALSE') return { kind: 'literal', value: token.value === 'TRUE' };
    if (this.peek().type === 'left') {
      this.take();
      const args: Node[] = [];
      if (this.peek().type !== 'right') {
        let hasMore = true;
        while (hasMore) {
          args.push(this.comparison());
          hasMore = this.peek().type === 'comma';
          if (hasMore) this.take();
        }
      }
      if (this.take().type !== 'right') throw new FormulaError('#VALUE!');
      return { kind: 'call', name: token.value, arguments: args };
    }
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/u.test(token.value)) throw new FormulaError('#NAME?');
    if (this.peek().type === 'colon') {
      this.take();
      const end = this.take();
      if (end.type !== 'identifier' || !/^[A-Z]{1,3}[1-9]\d{0,6}$/u.test(end.value)) throw new FormulaError('#REF!');
      return { kind: 'range', start: token.value, end: end.value };
    }
    return { kind: 'reference', address: token.value };
  }
}

const addressPoint = (address: string): { row: number; column: number } => {
  const matched = address.match(/^([A-Z]+)(\d+)$/u);
  if (!matched) throw new FormulaError('#REF!');
  let column = 0;
  for (const character of matched[1] ?? '') column = column * 26 + character.charCodeAt(0) - 64;
  return { row: Number(matched[2]) - 1, column: column - 1 };
};
const addressAt = (row: number, column: number): string => {
  let value = column + 1;
  let label = '';
  while (value > 0) { value -= 1; label = String.fromCharCode(65 + (value % 26)) + label; value = Math.floor(value / 26); }
  return `${label}${row + 1}`;
};
const error = (value: FormulaValue): FormulaError | undefined => value instanceof FormulaError ? value : undefined;
const flattened = (values: readonly FormulaValue[]): readonly FormulaValue[] => values.flatMap((value) => value instanceof FormulaError ? [value] : typeof value === 'object' ? value.values : [value]);
const numberValue = (value: FormulaValue): number | FormulaError => {
  if (value instanceof FormulaError) return value;
  if (typeof value === 'object') return new FormulaError('#VALUE!');
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (!value.trim()) return 0;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : new FormulaError('#VALUE!');
};
const textValue = (value: FormulaValue): string => {
  if (value instanceof FormulaError) return value.code;
  if (typeof value === 'object') return flattened(value.values).map(textValue).join('');
  return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
};
const truthy = (value: FormulaValue): boolean => {
  if (value instanceof FormulaError || typeof value === 'object') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value.length > 0 && value.toUpperCase() !== 'FALSE';
};
const numericValues = (values: readonly FormulaValue[]): number[] | FormulaError => {
  const result: number[] = [];
  for (const value of flattened(values)) {
    if (value instanceof FormulaError) return value;
    if (typeof value === 'number') result.push(value);
    else if (typeof value === 'boolean') result.push(value ? 1 : 0);
    else if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value.replaceAll(',', '')))) result.push(Number(value.replaceAll(',', '')));
  }
  return result;
};

const compare = (left: FormulaValue, right: FormulaValue, operator: string): boolean | FormulaError => {
  if (error(left) || error(right)) return error(left) ?? error(right) as FormulaError;
  const leftNumber = numberValue(left);
  const rightNumber = numberValue(right);
  const numeric = !(leftNumber instanceof FormulaError) && !(rightNumber instanceof FormulaError);
  const a = numeric ? leftNumber : textValue(left).toLocaleLowerCase();
  const b = numeric ? rightNumber : textValue(right).toLocaleLowerCase();
  if (operator === '=') return a === b;
  if (operator === '<>') return a !== b;
  if (operator === '<') return a < b;
  if (operator === '>') return a > b;
  if (operator === '<=') return a <= b;
  return a >= b;
};

const criterion = (value: FormulaValue, rule: FormulaValue): boolean => {
  const source = textValue(rule);
  const matched = source.match(/^(<=|>=|<>|=|<|>)(.*)$/u);
  if (matched) return compare(value, matched[2] ?? '', matched[1] ?? '=') === true;
  if (source.includes('*') || source.includes('?')) {
    const pattern = source.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
    return new RegExp(`^${pattern}$`, 'iu').test(textValue(value));
  }
  return compare(value, rule, '=') === true;
};

export type SpreadsheetFormulaEvaluator = Readonly<{
  display: (address: string) => string;
  value: (address: string) => FormulaValue;
}>;

export const createSpreadsheetFormulaEvaluator = (
  document: ArtifactDocument,
  sheet: ArtifactSheet,
  edits: FormulaEdits,
): SpreadsheetFormulaEvaluator => {
  const cells = new Map(sheet.rows.flat().map((cell) => [cell.address, cell]));
  const changes = new Map(edits?.cells.filter((cell) => cell.sheetId === sheet.id).map((cell) => [cell.address, cell.text]));
  const cache = new Map<string, FormulaValue>();
  const active = new Set<string>();

  const range = (start: string, end: string): FormulaValue => {
    const first = addressPoint(start);
    const last = addressPoint(end);
    const top = Math.min(first.row, last.row); const bottom = Math.max(first.row, last.row);
    const left = Math.min(first.column, last.column); const right = Math.max(first.column, last.column);
    if ((bottom - top + 1) * (right - left + 1) > MAX_FORMULA_RANGE_CELLS) return new FormulaError('#NUM!');
    const values: FormulaValue[] = [];
    for (let row = top; row <= bottom; row += 1) for (let column = left; column <= right; column += 1) values.push(value(addressAt(row, column)));
    return { kind: 'range', values, rows: bottom - top + 1, columns: right - left + 1 };
  };

  const call = (name: string, args: readonly FormulaValue[]): FormulaValue => {
    const nestedError = flattened(args).find((arg) => arg instanceof FormulaError);
    if (nestedError instanceof FormulaError) return nestedError;
    if (name === 'SUMPRODUCT') {
      const ranges = args.map((arg) => flattened([arg]));
      const length = Math.max(0, ...ranges.map((items) => items.length));
      let total = 0;
      for (let index = 0; index < length; index += 1) {
        let product = 1;
        for (const items of ranges) {
          const parsed = numberValue(items[index] ?? 0);
          if (parsed instanceof FormulaError) return parsed;
          product *= parsed;
        }
        total += product;
      }
      return total;
    }
    if (name === 'VLOOKUP') {
      const table = args[1];
      const column = numberValue(args[2] ?? 1);
      if (typeof table !== 'object' || table instanceof FormulaError || column instanceof FormulaError || column < 1 || column > table.columns) return new FormulaError('#REF!');
      for (let row = 0; row < table.rows; row += 1) {
        if (compare(table.values[row * table.columns] ?? '', args[0] ?? '', '=') === true) return table.values[row * table.columns + column - 1] ?? new FormulaError('#N/A');
      }
      return new FormulaError('#N/A');
    }
    if (name === 'XLOOKUP') {
      const lookup = flattened([args[1] ?? '']); const returned = flattened([args[2] ?? '']);
      const index = lookup.findIndex((item) => compare(item, args[0] ?? '', '=') === true);
      return index >= 0 ? returned[index] ?? new FormulaError('#N/A') : args[3] ?? new FormulaError('#N/A');
    }
    const numbers = numericValues(args);
    if (numbers instanceof FormulaError) return numbers;
    if (name === 'SUM') return numbers.reduce((sum, current) => sum + current, 0);
    if (name === 'AVERAGE') return numbers.length ? numbers.reduce((sum, current) => sum + current, 0) / numbers.length : new FormulaError('#DIV/0!');
    if (name === 'MIN') return numbers.length ? Math.min(...numbers) : 0;
    if (name === 'MAX') return numbers.length ? Math.max(...numbers) : 0;
    if (name === 'COUNT') return numbers.length;
    if (name === 'COUNTA') return flattened(args).filter((item) => textValue(item) !== '').length;
    if (name === 'AND') return flattened(args).every(truthy);
    if (name === 'OR') return flattened(args).some(truthy);
    if (name === 'NOT') return !truthy(args[0] ?? false);
    if (name === 'ABS' || name === 'SQRT') {
      const source = numberValue(args[0] ?? 0);
      if (source instanceof FormulaError) return source;
      if (name === 'SQRT' && source < 0) return new FormulaError('#NUM!');
      return name === 'ABS' ? Math.abs(source) : Math.sqrt(source);
    }
    if (name === 'POWER' || name === 'MOD') {
      const left = numberValue(args[0] ?? 0); const right = numberValue(args[1] ?? 0);
      if (left instanceof FormulaError || right instanceof FormulaError) return new FormulaError('#VALUE!');
      if (name === 'MOD' && right === 0) return new FormulaError('#DIV/0!');
      return name === 'POWER' ? left ** right : left % right;
    }
    if (['ROUND', 'ROUNDUP', 'ROUNDDOWN'].includes(name)) {
      const value = numberValue(args[0] ?? 0); const digits = numberValue(args[1] ?? 0);
      if (value instanceof FormulaError || digits instanceof FormulaError) return new FormulaError('#VALUE!');
      const places = Math.trunc(digits); const factor = 10 ** places; const source = value * factor;
      const rounded = name === 'ROUND' ? Math.round(source) : name === 'ROUNDUP' ? (source < 0 ? Math.floor(source) : Math.ceil(source)) : (source < 0 ? Math.ceil(source) : Math.floor(source));
      return rounded / factor;
    }
    if (name === 'CONCAT' || name === 'CONCATENATE') return flattened(args).map(textValue).join('');
    if (name === 'LEN') return textValue(args[0] ?? '').length;
    if (name === 'LEFT') { const count = numberValue(args[1] ?? 1); return count instanceof FormulaError ? count : textValue(args[0] ?? '').slice(0, count); }
    if (name === 'RIGHT') { const count = numberValue(args[1] ?? 1); return count instanceof FormulaError ? count : textValue(args[0] ?? '').slice(-count); }
    if (name === 'MID') {
      const start = numberValue(args[1] ?? 1); const count = numberValue(args[2] ?? 0);
      return start instanceof FormulaError || count instanceof FormulaError ? new FormulaError('#VALUE!') : textValue(args[0] ?? '').slice(Math.max(0, start - 1), Math.max(0, start - 1) + count);
    }
    if (name === 'LOWER') return textValue(args[0] ?? '').toLocaleLowerCase();
    if (name === 'UPPER') return textValue(args[0] ?? '').toLocaleUpperCase();
    if (name === 'TRIM') return textValue(args[0] ?? '').trim().replace(/\s+/gu, ' ');
    if (name === 'COUNTIF') return flattened([args[0] ?? '']).filter((item) => criterion(item, args[1] ?? '')).length;
    if (name === 'SUMIF') {
      const candidates = flattened([args[0] ?? '']); const sums = flattened([args[2] ?? args[0] ?? '']);
      return candidates.reduce<number>((total, item, index) => {
        if (!criterion(item, args[1] ?? '')) return total;
        const parsed = numberValue(sums[index] ?? 0); return total + (parsed instanceof FormulaError ? 0 : parsed);
      }, 0);
    }
    if (name === 'AVERAGEIF') {
      const candidates = flattened([args[0] ?? '']); const averages = flattened([args[2] ?? args[0] ?? '']);
      const selected = candidates.flatMap((item, index) => {
        if (!criterion(item, args[1] ?? '')) return [];
        const parsed = numberValue(averages[index] ?? 0); return parsed instanceof FormulaError ? [] : [parsed];
      });
      return selected.length ? selected.reduce((total, item) => total + item, 0) / selected.length : new FormulaError('#DIV/0!');
    }
    return new FormulaError('#NAME?');
  };

  const evaluate = (node: Node): FormulaValue => {
    if (node.kind === 'literal') return node.value;
    if (node.kind === 'reference') return value(node.address);
    if (node.kind === 'range') return range(node.start, node.end);
    if (node.kind === 'percent') { const parsed = numberValue(evaluate(node.value)); return parsed instanceof FormulaError ? parsed : parsed / 100; }
    if (node.kind === 'unary') { const parsed = numberValue(evaluate(node.value)); return parsed instanceof FormulaError ? parsed : node.operator === '-' ? -parsed : parsed; }
    if (node.kind === 'call') {
      if (node.name === 'IF') {
        const condition = evaluate(node.arguments[0] ?? { kind: 'literal', value: false });
        if (condition instanceof FormulaError) return condition;
        return evaluate(node.arguments[truthy(condition) ? 1 : 2] ?? { kind: 'literal', value: false });
      }
      if (node.name === 'IFERROR') {
        const attempted = evaluate(node.arguments[0] ?? { kind: 'literal', value: '' });
        return attempted instanceof FormulaError ? evaluate(node.arguments[1] ?? { kind: 'literal', value: '' }) : attempted;
      }
      return call(node.name, node.arguments.map(evaluate));
    }
    const left = evaluate(node.left); const right = evaluate(node.right);
    if (node.operator === '&') return `${textValue(left)}${textValue(right)}`;
    if (['=', '<>', '<', '>', '<=', '>='].includes(node.operator)) return compare(left, right, node.operator);
    const a = numberValue(left); const b = numberValue(right);
    if (a instanceof FormulaError || b instanceof FormulaError) return a instanceof FormulaError ? a : b;
    if (node.operator === '+') return a + b;
    if (node.operator === '-') return a - b;
    if (node.operator === '*') return a * b;
    if (node.operator === '/') return b === 0 ? new FormulaError('#DIV/0!') : a / b;
    return a ** b;
  };

  const value = (address: string): FormulaValue => {
    const normalized = address.toUpperCase();
    if (cache.has(normalized)) return cache.get(normalized) as FormulaValue;
    if (active.has(normalized)) return new FormulaError('#CYCLE!');
    active.add(normalized);
    const cell = cells.get(normalized);
    const raw = changes.has(normalized) ? changes.get(normalized) ?? '' : cell?.formula ? `=${cell.formula}` : cell?.text ?? '';
    let result: FormulaValue;
    if (raw.startsWith('=')) {
      try { result = evaluate(new Parser(tokenize(raw.slice(1))).parse()); }
      catch (reason) { result = reason instanceof FormulaError ? reason : new FormulaError('#VALUE!'); }
    } else if (/^(?:TRUE|FALSE)$/iu.test(raw.trim())) result = raw.trim().toUpperCase() === 'TRUE';
    else if (raw.trim() && Number.isFinite(Number(raw.replaceAll(',', '')))) result = Number(raw.replaceAll(',', ''));
    else result = raw;
    active.delete(normalized);
    cache.set(normalized, result);
    return result;
  };

  const display = (address: string): string => {
    const result = value(address);
    if (result instanceof FormulaError) return result.code;
    if (typeof result === 'object') return '';
    if (typeof result === 'boolean') return result ? 'TRUE' : 'FALSE';
    if (typeof result === 'number') return Number.isFinite(result) ? String(Number(result.toPrecision(12))) : '#NUM!';
    return result;
  };
  void document;
  return { display, value };
};

export const spreadsheetFormulaCatalog = [
  ['求和', 'SUM', '=SUM(A1:A10)'], ['平均值', 'AVERAGE', '=AVERAGE(A1:A10)'],
  ['条件判断', 'IF', '=IF(A1>0,"是","否")'], ['条件求和', 'SUMIF', '=SUMIF(A1:A10,">0",B1:B10)'],
  ['条件计数', 'COUNTIF', '=COUNTIF(A1:A10,">0")'], ['四舍五入', 'ROUND', '=ROUND(A1,2)'],
  ['最大值', 'MAX', '=MAX(A1:A10)'], ['最小值', 'MIN', '=MIN(A1:A10)'],
] as const;
